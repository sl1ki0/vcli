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
import { balanced, boundText, BudgetContextPlanner, estimateTokens } from "./context.ts";
import { PermissionGate, ToolRegistry } from "./tools.ts";

import { SourceReadCache } from "./source-read-cache.ts";
import { conversation, startMessage } from "./conversation.ts";
import { reserveDelegation } from "./delegation-budget.ts";

interface ToolExecution {
  call: ToolCall;
  result: ToolResult;
}

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
  executeTool?: (
    call: ToolCall,
    context: ToolContext,
    execute: () => Promise<ToolResult>,
  ) => Promise<ToolResult>;
}
export class AgentRuntime {
  readonly settings: ContextSettings;
  private session?: Session;
  private readonly readSpans = new SourceReadCache();
  constructor(private readonly options: RuntimeOptions) {
    this.settings = { ...balanced, ...options.settings };
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
  private async emit(type: RuntimeEvent["type"], data: Record<string, unknown>): Promise<void> {
    const event: RuntimeEvent = {
      type,
      data,
      sessionId: this.session!.id,
      time: new Date().toISOString(),
    };
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
  async run(prompt: string, signal: AbortSignal, resumeId?: string): Promise<Session> {
    this.readSpans.clear();
    const { root, provider, store, architecture, tools } = this.options;
    this.session = resumeId
      ? await store.get(resumeId)
      : await store.create(root, provider, prompt);
    if (!this.session) throw new Error(`Session not found: ${resumeId}`);
    const session = this.session;
    session.instructions =
      typeof this.options.instructions === "function"
        ? await this.options.instructions()
        : this.options.instructions;
    session.mode = this.options.mode ?? session.mode ?? "build";
    if (session.root !== root) throw new Error("Session belongs to a different project.");
    conversation(session);
    if (session.provider !== provider.id || session.model !== provider.model) {
      session.messages = session.messages.map((m) => ({ ...m, providerData: undefined }));
      session.provider = provider.id;
      session.model = provider.model;
    }
    session.status = "running";
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
    let graph: ArchitectureGraph;
    try {
      graph = await architecture.scan(root);
      await this.recoverInterruptedCalls(session);
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
          session.status = "complete";
          break;
        }
        const mutated = await this.executeBatch(session, calls, signal);
        if (mutated) {
          graph = await architecture.scan(root);
          await this.emit("architecture", { graph, revision: graph.revision });
        }
        if (turn === this.settings.maxTurns - 1) session.status = "budget";
      }
    } catch (error) {
      session.status = signal.aborted ? "aborted" : "failed";
      await this.emit("status", {
        status: session.status,
        error: error instanceof Error ? error.message : String(error),
      });
      await store.save(session);
      if (!signal.aborted) throw error;
    }
    await store.save(session);
    await this.emit("status", { status: session.status });
    return session;
  }

  private async recoverInterruptedCalls(session: Session): Promise<void> {
    const { store } = this.options;
    const uncertain = await store.pendingMutations(session.id);
    for (const name of uncertain)
      session.ledger.constraints.push(
        `Previous ${name} has an uncertain outcome. Inspect state before any related action; do not replay it.`,
      );
    // Close unfinished call groups without repeating their effects.
    const completed = new Set(
      session.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId),
    );
    for (const m of [...session.messages])
      for (const call of m.toolCalls ?? [])
        if (!completed.has(call.id))
          session.messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            text: "Interrupted before a recorded result. Outcome uncertain; inspect current state. Do not replay automatically.",
          });

    await store.save(session);
  }

  private prepareRequest(session: Session, graph: ArchitectureGraph): ModelRequest | undefined {
    const { provider, tools } = this.options;
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
        if (event.type === "usage") usage = event.usage;
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
    if (usage.input + usage.output > 0) session.budgetSpent = spent + usage.input + usage.output;
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

  private async executeTool(
    session: Session,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    const { tools, root } = this.options;
    const tool = tools.get(call.name);
    try {
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      if (session.mode === "plan" && tool.kind !== "read")
        throw new Error(`Plan mode denies ${tool.name}. Switch to build mode to implement.`);
      tools.validate(call);
      await this.options.permissions.authorize(tool, call.arguments);
      // Durable start precedes the side effect.
      await this.emit("tool-start", {
        callId: call.id,
        name: call.name,
        kind: tool.kind,
        arguments: call.arguments,
      });
      const context = { root, signal, sessionId: session.id };
      const result = await tools.executeWith(call, context, (execute) =>
        this.options.executeTool ? this.options.executeTool(call, context, execute) : execute(),
      );
      return { call, result };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        call,
        result: {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        },
      };
    }
  }

  private async recordToolResult(session: Session, { call, result }: ToolExecution): Promise<void> {
    const { store } = this.options;
    const full = result.fullOutput ?? result.text;
    const artifact = await store.putArtifact(session.id, full);
    const content = this.readSpans.deduplicate(call, result, artifact);
    const output = `${boundText(content, this.settings.resultTokens)}\nFull result: ${artifact}`;
    session.messages.push({
      role: "tool",
      text: output,
      toolCallId: call.id,
      toolName: call.name,
    });
    session.ledger.touchedPaths = [
      ...new Set([...session.ledger.touchedPaths, ...(result.changedPaths ?? [])]),
    ];
    if (call.name === "shell_run") session.ledger.verification.push(boundText(result.text, 400));
    await store.save(session);
    await this.emit("tool-end", {
      callId: call.id,
      name: call.name,
      result: output,
      artifact,
      isError: result.isError ?? false,
      details: result.details,
      changedPaths: result.changedPaths,
    });
  }

  private async executeBatch(
    session: Session,
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const { tools } = this.options;
    let mutated = false;
    const execute = (call: ToolCall) => this.executeTool(session, call, signal);
    const recordResult = (result: ToolExecution) => this.recordToolResult(session, result);
    // Read batches may run concurrently; writes and arbitrary shell effects form barriers.
    for (let i = 0; i < calls.length; ) {
      if (tools.get(calls[i]!.name)?.kind === "read" && !this.options.serialTools?.()) {
        const reads: ToolCall[] = [];
        while (i < calls.length && reads.length < 4 && tools.get(calls[i]!.name)?.kind === "read")
          reads.push(calls[i++]!);
        // Drain every child before propagating cancellation: their usage and mutation
        // records must be durable before the host closes the session store.
        const results = await Promise.allSettled(reads.map(execute));
        for (const result of results)
          if (result.status === "fulfilled") await recordResult(result.value);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } else {
        await recordResult(await execute(calls[i++]!));
        mutated = true;
      }
    }

    return mutated;
  }
}
