import type {
  ArchitectureGraph,
  ArchitectureService,
  ContextSettings,
  Message,
  ModelRequest,
  ProviderAdapter,
  RuntimeEvent,
  Session,
  SessionStore,
  ToolCall,
  ToolContext,
  ToolResult,
  Usage,
} from "./contracts.ts";
import { balanced, BudgetContextPlanner, estimateTokens } from "./context.ts";
import type { PermissionGate, ToolRegistry } from "./tools.ts";

import { ToolExecutionController } from "./runtime-tools.ts";
import { conversation, startMessage } from "./conversation.ts";
import { reserveDelegation } from "./delegation-budget.ts";
import { applyToolConversationEvent } from "./tool-history.ts";
import {
  initializeRunState,
  PendingApprovalError,
  reserveModelRequest,
  RunBudgetError,
  UncertainToolError,
  type RunLimits,
} from "./run-state.ts";
import { unfinishedPlanTasks } from "./run-plan.ts";

export interface RuntimeOptions {
  root: string;
  provider: ProviderAdapter;
  tools: ToolRegistry;
  architecture: ArchitectureService;
  store: SessionStore;
  permissions: PermissionGate;
  settings?: Partial<ContextSettings>;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  instructions?: string | (() => Promise<string>);
  serialTools?: () => boolean;
  mode?: "build" | "plan";
  runLimits?: Partial<RunLimits>;
  executionPolicy?: { path: string };
  /** Bounds a single unknown output reservation while leaving room for explicit recovery. */
  resultBytesPerCall?: number;
  /** Policy preflight occurs before approval, then again immediately before effects. */
  beforeTool?: (call: ToolCall, context: ToolContext) => Promise<void>;
  /** Includes hooks and lazy external startup even when a tool itself is a read. */
  sideEffectCost?: (call: ToolCall) => number;
  inspectUncertain?: (call: ToolCall, context: ToolContext) => Promise<string>;
  /** Failure injection / durable external effect accounting before result persistence. */
  afterToolEffect?: (call: ToolCall, context: ToolContext, result: ToolResult) => Promise<void>;
  executeTool?: (
    call: ToolCall,
    context: ToolContext,
    execute: () => Promise<ToolResult>,
  ) => Promise<ToolResult>;
}
export class AgentRuntime {
  readonly settings: ContextSettings;
  private session?: Session;
  private readonly toolExecution: ToolExecutionController;
  constructor(private readonly options: RuntimeOptions) {
    this.settings = { ...balanced, ...options.settings };
    this.toolExecution = new ToolExecutionController(options, this.settings, this.emit.bind(this));
  }
  get currentSession(): Session | undefined {
    return this.session;
  }
  async reserveDelegation(tokens: number) {
    if (!this.session) throw new Error("No active session");
    const session = this.session;
    return reserveDelegation(session, tokens, this.settings.taskTokens, () =>
      this.options.store.save(session),
    );
  }
  private async emit(
    type: RuntimeEvent["type"],
    data: Record<string, unknown>,
    options: { saveSession?: boolean } = {},
  ): Promise<void> {
    const event: RuntimeEvent = {
      type,
      data,
      sessionId: this.session!.id,
      time: new Date().toISOString(),
    };
    if (type === "tool-request" || type === "tool-start" || type === "tool-end") {
      applyToolConversationEvent(conversation(this.session!), event);
      this.session!.chatToolsVersion = 1;
    }
    if (options.saveSession) await this.options.store.save(this.session!);
    await this.options.store.append(event);
    await this.options.onEvent?.(event);
  }
  async record(values: {
    decisions?: string[];
    constraints?: string[];
    pending?: string[];
    verification?: string[];
  }): Promise<void> {
    if (!this.session) throw new Error("No active session");
    const ledger = this.session.ledger;
    for (const key of ["decisions", "constraints", "verification"] as const)
      if (values[key]) ledger[key] = [...new Set([...ledger[key], ...values[key]!])];
    if (values.pending) ledger.pending = values.pending;
    await this.options.store.save(this.session);
  }
  private async beginSession(prompt: string, resumeId?: string): Promise<Session> {
    this.toolExecution.clearReadCache();
    const { root, provider, store } = this.options;
    this.session = resumeId
      ? await store.get(resumeId)
      : await store.create(root, provider, prompt);
    if (!this.session) throw new Error(`Session not found: ${resumeId}`);
    const session = this.session;
    initializeRunState(session, this.options.runLimits);
    if (
      session.executionPolicy &&
      this.options.executionPolicy?.path !== session.executionPolicy.path
    )
      throw new Error("Resume must retain the saved execution policy.");
    session.executionPolicy ??= this.options.executionPolicy;
    session.instructions =
      typeof this.options.instructions === "function"
        ? await this.options.instructions()
        : this.options.instructions;
    if (
      session.mode === "plan" &&
      this.options.mode === "build" &&
      session.plan?.status !== "approved"
    )
      throw new Error(
        "Approve a saved structured plan before entering build mode. A plain-text plan cannot authorize execution.",
      );
    session.mode = this.options.mode ?? session.mode ?? "build";
    if (
      prompt &&
      session.plan?.status === "approved" &&
      !unfinishedPlanTasks(session.plan).length
    ) {
      session.planHistory = [...(session.planHistory ?? []), session.plan];
      session.plan = undefined;
    }
    if (session.root !== root) throw new Error("Session belongs to a different project.");
    this.options.permissions.bindSession(session, () => store.save(session));
    conversation(session);
    if (session.provider !== provider.id || session.model !== provider.model) {
      session.messages = session.messages.map((m) => ({ ...m, providerData: undefined }));
      session.provider = provider.id;
      session.model = provider.model;
    }
    session.status = "running";
    if (prompt) session.invalidToolRequests = undefined;
    const user = prompt ? startMessage(session, "user", prompt) : undefined;
    if (prompt) session.messages.push({ role: "user", text: prompt });
    await store.save(session);
    await this.emit("session", {
      id: session.id,
      mode: this.options.permissions.mode,
      goal: session.ledger.goal,
    });
    if (user)
      await this.emit("message-start", {
        messageId: user.id,
        role: user.role,
        text: user.text,
        createdAt: user.createdAt,
      });
    return session;
  }
  async run(prompt: string, signal: AbortSignal, resumeId?: string): Promise<Session> {
    const session = await this.beginSession(prompt, resumeId);
    const { store, architecture, root } = this.options;
    if (session.invalidToolRequests?.blocked) {
      session.status = "failed";
      await this.recoverInterruptedCalls(session);
      await store.save(session);
      await this.emit("status", {
        status: session.status,
        error: session.invalidToolRequests.blocked.reason,
      });
      return session;
    }
    let graph: ArchitectureGraph;
    let completionError: string | undefined;
    try {
      graph = await architecture.scan(root);
      await this.recoverInterruptedCalls(session);
      if (session.runState!.aborted) {
        session.status = "failed";
        await store.save(session);
        return session;
      }
      const uncertain = Object.values(session.runState!.calls).find(
        (entry) => entry.status === "uncertain",
      );
      if (uncertain) throw new UncertainToolError(uncertain.call.id);
      if (
        !prompt &&
        !session.runState!.pending.length &&
        session.plan?.status === "approved" &&
        !unfinishedPlanTasks(session.plan).length
      ) {
        session.status = "complete";
        await store.save(session);
        await this.emit("status", { status: session.status });
        return session;
      }
      if (session.runState!.pending.length) {
        const pending = session.runState!.pending.map((id) => {
          const entry = session.runState!.calls[id]!;
          return entry.requestedTaskId === undefined
            ? entry.call
            : { ...entry.call, taskId: entry.requestedTaskId ?? undefined };
        });
        if (await this.toolExecution.executeBatch(session, pending, signal))
          graph = await architecture.scan(root);
      }
      await this.emit("architecture", { revision: graph.revision, graph });
      for (let turn = 0; turn < this.settings.maxTurns; turn++) {
        signal.throwIfAborted();
        const request = this.prepareRequest(session, graph);
        if (!request) {
          session.status = "budget";
          break;
        }
        await this.reportCompaction(session, request);
        const calls = await this.infer(session, request, signal);
        if (!calls.length) {
          session.status =
            session.mode === "plan"
              ? session.plan?.status === "draft"
                ? "awaiting-plan"
                : "failed"
              : session.plan && unfinishedPlanTasks(session.plan).length
                ? "failed"
                : "complete";
          if (session.status === "failed") {
            completionError =
              session.mode === "plan"
                ? "Plan mode requires a saved structured plan. Publish one with plan_publish before requesting approval."
                : "The model stopped before all plan tasks had verified results.";
            session.ledger.constraints.push(completionError);
          }
          break;
        }
        const mutated = await this.toolExecution.executeBatch(session, calls, signal);
        if (mutated) {
          graph = await architecture.scan(root);
          await this.emit("architecture", { graph, revision: graph.revision });
        }
        if (session.invalidToolRequests?.blocked) {
          session.status = "failed";
          break;
        }
        if (turn === this.settings.maxTurns - 1) session.status = "budget";
      }
    } catch (error) {
      session.status = signal.aborted
        ? "aborted"
        : error instanceof RunBudgetError
          ? "budget"
          : error instanceof PendingApprovalError
            ? "awaiting-approval"
            : error instanceof UncertainToolError
              ? "uncertain"
              : "failed";
      for (const message of conversation(session))
        if (
          (session.status === "failed" || session.status === "aborted") &&
          (message.tool?.state === "requested" || message.tool?.state === "running")
        ) {
          message.tool.state = "interrupted";
          message.status = signal.aborted ? "aborted" : "failed";
          message.text = "No completion was recorded. Inspect current state before retrying.";
        }
      await store.save(session);
      await this.emit("status", {
        status: session.status,
        error: error instanceof Error ? error.message : String(error),
      });
      if (
        !signal.aborted &&
        !(error instanceof RunBudgetError) &&
        !(error instanceof PendingApprovalError) &&
        !(error instanceof UncertainToolError)
      )
        throw error;
    }
    await store.save(session);
    await this.emit("status", {
      status: session.status,
      ...(session.invalidToolRequests?.blocked
        ? { error: session.invalidToolRequests.blocked.reason }
        : completionError
          ? { error: completionError }
          : {}),
    });
    return session;
  }

  private async recoverInterruptedCalls(session: Session): Promise<void> {
    const { store } = this.options;
    const state = session.runState!;
    for (const entry of Object.values(state.calls))
      if (entry.status === "started" || entry.status === "uncertain") {
        entry.status = "uncertain";
        let inspection = "";
        if (this.options.inspectUncertain)
          inspection = await this.options.inspectUncertain(entry.call, {
            root: session.root,
            signal: new AbortController().signal,
            sessionId: session.id,
          });
        if (inspection) {
          const digest = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inspection)),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (entry.inspection?.digest !== digest)
            entry.inspection = {
              digest,
              artifact: await store.putArtifact(session.id, inspection),
            };
        }
        const prefix = `Uncertain tool call ${entry.call.id}:`;
        const constraint = `${prefix} previous ${entry.call.name} has an uncertain outcome. Inspect state before any related action; do not replay it.${entry.inspection ? ` Recovery inspection artifact: ${entry.inspection.artifact}.` : ""}`;
        session.ledger.constraints = session.ledger.constraints.filter(
          (item) => !item.startsWith(prefix),
        );
        session.ledger.constraints.push(constraint);
      }
    const uncertain = await store.pendingMutations(session.id);
    for (const name of uncertain) {
      const constraint = `Previous ${name} has an uncertain outcome. Inspect state before any related action; do not replay it.`;
      if (!session.ledger.constraints.includes(constraint))
        session.ledger.constraints.push(constraint);
    }
    const completed = new Set(
      session.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId),
    );
    for (const message of [...session.messages])
      for (const call of message.toolCalls ?? []) {
        const entry = Object.hasOwn(state.calls, call.id) ? state.calls[call.id] : undefined;
        // Reserved/approval calls belong to a durable batch and resume without another model request.
        if (entry && entry.status !== "uncertain") continue;
        if (!completed.has(call.id)) {
          await this.toolExecution.recordResult(session, {
            call,
            result: {
              text: "Interrupted before a recorded result. Outcome uncertain; inspect current state. Do not replay automatically.",
              isError: true,
            },
            interrupted: true,
          });
          completed.add(call.id);
        }
      }

    await store.save(session);
  }

  private prepareRequest(session: Session, graph: ArchitectureGraph): ModelRequest | undefined {
    const { provider, tools } = this.options;
    if (session.mode === "plan") tools.activate(["plan_publish"]);
    if (session.plan?.status === "approved") tools.activate(["plan_task"]);
    const request = new BudgetContextPlanner().build(
      session,
      graph,
      tools.schemas(this.settings.schemaTokens),
      this.settings,
      provider.contextWindow,
    );
    const inputEstimate = estimateTokens(
      request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools),
    );
    if (this.settings.taskTokens !== undefined) {
      const remaining =
        this.settings.taskTokens -
        (session.budgetSpent ?? session.usage.input + session.usage.output);
      if (remaining < inputEstimate + 256) {
        return undefined;
      }
      request.maxOutputTokens = Math.min(request.maxOutputTokens, remaining - inputEstimate);
    }

    return request;
  }

  private async reportCompaction(session: Session, request: ModelRequest): Promise<void> {
    if (request.messages.length < session.messages.length)
      await this.emit("compaction", {
        retained: request.messages.length,
        total: session.messages.length,
        ledgerPreserved: true,
      });
  }

  private async infer(
    session: Session,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ToolCall[]> {
    const { provider, store } = this.options;
    const spent = session.budgetSpent ?? session.usage.input + session.usage.output;
    const reservation =
      estimateTokens(
        request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools),
      ) + request.maxOutputTokens;
    reserveModelRequest(session.runState!);
    session.budgetSpent = spent + reservation;
    // Save before inference: cancellation or absent usage must not reset a budget.
    await store.save(session);
    const response = startMessage(session, "assistant");
    await this.emit("message-start", {
      messageId: response.id,
      role: response.role,
      createdAt: response.createdAt,
    });
    const calls: ToolCall[] = [];
    let providerData: unknown;
    let usage: Usage = { input: 0, output: 0, cached: 0 };
    try {
      for await (const event of provider.stream(request, signal)) {
        if (event.type === "text") {
          response.text += event.text;
          await this.emit("text", { messageId: response.id, text: event.text });
        }
        if (event.type === "reasoning") {
          response.reasoning = (response.reasoning ?? "") + event.text;
          await this.emit("reasoning", { messageId: response.id, text: event.text });
        }
        if (event.type === "tool-call") calls.push(event.call);
        if (event.type === "usage") {
          const { input, output, cached } = event.usage;
          usage = [input, output, cached, input + output].every(
            (count) => Number.isSafeInteger(count) && count >= 0,
          )
            ? { input, output, cached }
            : { input: 0, output: 0, cached: 0 };
        }
        if (event.type === "done") providerData = event.providerData;
      }
      signal.throwIfAborted();
      response.status = "complete";
    } catch (error) {
      response.status = signal.aborted ? "aborted" : "failed";
      await this.emit("message-end", { messageId: response.id, status: response.status });
      throw error;
    }
    session.usage.input += usage.input;
    session.usage.output += usage.output;
    session.usage.cached += usage.cached;
    const measured = usage.input + usage.output;
    const producedOutput = Boolean(response.text || response.reasoning || calls.length);
    // Missing components normalize to zero at provider boundaries. A nonempty
    // request/response cannot be free: retain its reservation for partial usage.
    const completeUsage = usage.input > 0 && (usage.output > 0 || !producedOutput);
    session.budgetSpent = spent + (completeUsage ? measured : Math.max(reservation, measured));
    const assistant: Message = {
      role: "assistant",
      text: response.text,
      providerData,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
    session.messages.push(assistant);
    await store.save(session);
    // Complete presentation only after the provider's continuation is durable.
    await this.emit("message-end", { messageId: response.id, status: response.status });
    await this.emit("usage", { usage, total: session.usage });

    return calls;
  }
}
