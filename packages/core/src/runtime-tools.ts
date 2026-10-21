import type {
  ContextSettings,
  Message,
  RuntimeEvent,
  Session,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolDefinition,
} from "./contracts.ts";
import type { RuntimeOptions } from "./runtime.ts";
import { boundText } from "./context.ts";
import { ToolValidationError } from "./tools.ts";
import { SourceReadCache } from "./source-read-cache.ts";
import {
  capToolResult,
  PendingApprovalError,
  reserveRunBatch,
  reserveRunOutput,
  RunBudgetError,
  savedCall,
  settleRunOutput,
  startRunCall,
  UncertainToolError,
  toolResultBytes,
} from "./run-state.ts";
import { recordPlanToolResult, startPlanTask } from "./run-plan.ts";
import { recordInvalidToolRequest, resetInvalidToolRequests } from "./invalid-tool-requests.ts";

interface ToolExecution {
  call: ToolCall;
  result: ToolResult;
  blocked?: boolean;
  interrupted?: boolean;
  replay?: boolean;
  /** A throwing executor may have produced output/effects that were never returned. */
  retainOutputReservation?: boolean;
}

export class ToolExecutionController {
  private readonly readSpans = new SourceReadCache();
  constructor(
    private readonly options: RuntimeOptions,
    private readonly settings: ContextSettings,
    private readonly emit: (
      type: RuntimeEvent["type"],
      data: Record<string, unknown>,
      options?: { saveSession?: boolean },
    ) => Promise<void>,
  ) {}
  clearReadCache(): void {
    this.readSpans.clear();
  }
  private async executeTool(
    session: Session,
    call: ToolCall,
    signal: AbortSignal,
    maximumBytes?: number,
  ): Promise<ToolExecution> {
    const { tools, root, store } = this.options;
    const state = session.runState!;
    const entry = savedCall(state, call)!;
    if (entry.status === "complete")
      return {
        call,
        result: { text: entry.result!.output, isError: entry.result!.isError },
        replay: true,
      };
    if (entry.status === "uncertain" || entry.status === "started")
      throw new UncertainToolError(call.id);
    if (entry.forcedResult) return { call, result: entry.forcedResult };
    await this.emit("tool-request", {
      callId: call.id,
      name: call.name,
      kind: tools.get(call.name)?.kind,
      arguments: call.arguments,
    });
    const outputAllowance = (maximum = maximumBytes) =>
      reserveRunOutput(
        state,
        entry,
        Math.min(
          maximum ?? Number.MAX_SAFE_INTEGER,
          this.options.resultBytesPerCall ?? 16 * 1024 * 1024,
        ),
      );
    const blockedResult = (): ToolExecution => ({
      call,
      result: capToolResult(
        { text: session.invalidToolRequests!.blocked!.reason, isError: true },
        outputAllowance(),
      ),
      blocked: true,
    });
    if (session.invalidToolRequests?.blocked) return blockedResult();
    let effectFinished = false;
    let executionStarted = false;
    try {
      const tool = tools.validate(call);
      if (tool.kind !== entry.kind)
        throw new Error(`Tool contract changed for ${tool.name}. Request a new tool call.`);
      if (resetInvalidToolRequests(session, call.name)) await store.save(session);
      if (session.invalidToolRequests?.blocked) return blockedResult();
      if (session.mode === "plan" && tool.kind !== "read")
        throw new Error(`Plan mode denies ${tool.name}. Switch to build mode to implement.`);
      const context: ToolContext = { root, signal, sessionId: session.id };
      if (
        session.plan &&
        session.mode !== "plan" &&
        !["plan_publish", "plan_task"].includes(tool.name)
      ) {
        const task = startPlanTask(session.plan, entry.call.taskId ?? call.taskId);
        call.taskId = task.id;
        entry.call.taskId = task.id;
        context.taskId = task.id;
      }
      await this.options.beforeTool?.(call, context);
      const summary = context.effectSummary;
      const approvalTool: ToolDefinition =
        entry.sideEffects > 0
          ? {
              ...tool,
              kind: tool.kind === "read" ? "execute" : tool.kind,
              description: summary
                ? `${tool.description}\nExecution effects: ${summary}`
                : tool.description,
            }
          : tool;
      await this.options.permissions.authorize(
        approvalTool,
        summary ? { ...call.arguments, additionalRuntimeEffects: summary } : call.arguments,
        call.id,
        context.requireApproval ||
          entry.status === "approval" ||
          entry.approval?.decision !== undefined,
      );
      if (session.invalidToolRequests?.blocked) return blockedResult();
      context.effectsAuthorized =
        Boolean(summary) && entry.sideEffects > (tool.kind === "read" ? 0 : 1);
      tools.validate(call);
      await this.options.beforeTool?.(call, context);
      if (context.effectSummary !== summary)
        throw new Error(`Execution effects changed for ${tool.name}. Request approval again.`);
      if (
        (this.options.sideEffectCost?.(call) ?? (tool.kind === "read" ? 0 : 1)) > entry.sideEffects
      )
        throw new Error(`Side-effect contract changed for ${tool.name}. Request a new tool call.`);
      this.options.permissions.assertAllowed(approvalTool);
      context.resultBytes = startRunCall(
        state,
        entry,
        Math.min(
          maximumBytes ?? Number.MAX_SAFE_INTEGER,
          this.options.resultBytesPerCall ?? 16 * 1024 * 1024,
        ),
      );
      // Counters, attempt and start identity share one atomic session snapshot.
      await store.save(session);
      await this.emit("tool-start", {
        callId: call.id,
        name: call.name,
        kind: tool.kind,
        arguments: call.arguments,
        taskId: context.taskId,
        attempt: entry.attempts,
      });
      this.options.permissions.assertAllowed(approvalTool);
      executionStarted = true;
      const result = await tools.executeWith(call, context, (execute) =>
        this.options.executeTool ? this.options.executeTool(call, context, execute) : execute(),
      );
      effectFinished = true;
      await this.options.afterToolEffect?.(call, context, result);
      return { call, result: capToolResult(result, context.resultBytes) };
    } catch (error) {
      // An error after effects but before result persistence is intentionally uncertain.
      if (
        effectFinished ||
        signal.aborted ||
        error instanceof PendingApprovalError ||
        error instanceof RunBudgetError
      )
        throw error;
      let text = error instanceof Error ? error.message : String(error);
      if (executionStarted && entry.sideEffects > 0)
        return {
          call,
          result: capToolResult(
            {
              text: `${text}\nTool execution threw after its effect boundary. Outcome uncertain; inspect and explicitly resolve this action before continuing. Do not replay automatically.`,
              isError: true,
              outcomeUncertain: true,
            },
            entry.resultAllowance!,
          ),
          retainOutputReservation: true,
        };
      let blocked = false;
      if (error instanceof ToolValidationError) {
        text = recordInvalidToolRequest(session, call.name, error);
        blocked = Boolean(session.invalidToolRequests?.blocked);
        await store.save(session);
      }
      return {
        call,
        result: capToolResult({ text, isError: true }, outputAllowance()),
        blocked,
      };
    }
  }

  async recordResult(
    session: Session,
    { call, result, blocked, interrupted, replay, retainOutputReservation }: ToolExecution,
  ): Promise<void> {
    const { store } = this.options;
    const state = session.runState!;
    const entry = Object.hasOwn(state.calls, call.id) ? state.calls[call.id] : undefined;
    const full = result.fullOutput ?? result.text;
    const artifact = replay ? entry!.result!.artifact : await store.putArtifact(session.id, full);
    const content = replay ? "" : this.readSpans.deduplicate(call, result, artifact);
    const output = replay
      ? entry!.result!.output
      : `${boundText(content, this.settings.resultTokens)}\nFull result: ${artifact}${result.incomplete ? "\n[Result incomplete: run result byte limit]" : ""}`;
    const message: Message = {
      role: "tool",
      text: output,
      toolCallId: call.id,
      toolName: call.name,
    };
    // Keep a recovered original batch together even when a human prompt arrived on resume.
    let insert = -1;
    for (let i = session.messages.length - 1; i >= 0; i--)
      if (session.messages[i]!.toolCalls?.some((item) => item.id === call.id)) {
        insert = i + 1;
        break;
      }
    if (insert >= 0) {
      let previous = -1;
      while (session.messages[insert]?.role === "tool") {
        if (session.messages[insert]!.toolCallId === call.id) previous = insert;
        insert++;
      }
      if (previous >= 0) session.messages[previous] = message;
      else session.messages.splice(insert, 0, message);
    } else session.messages.push(message);
    session.ledger.touchedPaths = [
      ...new Set([...session.ledger.touchedPaths, ...(result.changedPaths ?? [])]),
    ];
    if (call.name === "shell_run") session.ledger.verification.push(boundText(result.text, 400));
    if (entry && !interrupted && !replay) {
      if (!entry.forcedResult && !retainOutputReservation)
        settleRunOutput(state, entry, toolResultBytes(result));
      entry.status = result.outcomeUncertain ? "uncertain" : "complete";
      entry.result = {
        output,
        artifact,
        isError: result.isError ?? false,
        incomplete: result.incomplete,
      };
      entry.forcedResult = undefined;
      if (!result.outcomeUncertain) state.pending = state.pending.filter((id) => id !== call.id);
      if (
        !result.outcomeUncertain &&
        session.plan &&
        call.taskId &&
        !["plan_publish", "plan_task"].includes(call.name)
      )
        recordPlanToolResult(session.plan, call.taskId, call.id, call.name, result);
    }
    if (replay) state.pending = state.pending.filter((id) => id !== call.id);
    await this.emit(
      "tool-end",
      {
        callId: call.id,
        name: call.name,
        kind: this.options.tools.get(call.name)?.kind,
        arguments: call.arguments,
        result: output,
        artifact,
        isError: result.isError ?? false,
        blocked: blocked ?? false,
        interrupted: interrupted ?? false,
        details: result.details,
        changedPaths: result.changedPaths,
        taskId: call.taskId,
        incomplete: result.incomplete ?? false,
      },
      { saveSession: true },
    );
  }

  async executeBatch(session: Session, calls: ToolCall[], signal: AbortSignal): Promise<boolean> {
    const { tools } = this.options;
    const state = session.runState!;
    reserveRunBatch(state, calls, (call) => {
      const tool = tools.get(call.name);
      const kind = tool?.kind ?? "read";
      const baseCost = kind === "read" ? 0 : 1;
      const sideEffects = this.options.sideEffectCost?.(call) ?? baseCost;
      const retrySafe = sideEffects === baseCost && (tool?.retrySafe ?? kind === "read");
      return { kind, retrySafe, sideEffects };
    });
    await this.options.store.save(session);
    calls = [...new Map(calls.map((call) => [call.id, call])).values()];
    let mutated = false;
    const execute = (call: ToolCall, maximumBytes?: number) =>
      this.executeTool(session, call, signal, maximumBytes);
    const recordResult = async (result: ToolExecution) => {
      await this.recordResult(session, result);
      if (result.result.outcomeUncertain) throw new UncertainToolError(result.call.id);
    };
    // Read batches may run concurrently; writes and arbitrary shell effects form barriers.
    const concurrentRead = (call: ToolCall) =>
      tools.get(call.name)?.kind === "read" &&
      state.calls[call.id]?.sideEffects === 0 &&
      !["plan_publish", "plan_task"].includes(call.name);
    for (let i = 0; i < calls.length; ) {
      if (concurrentRead(calls[i]!) && !this.options.serialTools?.()) {
        const reads: ToolCall[] = [];
        while (i < calls.length && reads.length < 4 && concurrentRead(calls[i]!))
          reads.push(calls[i++]!);
        // Drain every child before propagating cancellation: their usage and mutation
        // records must be durable before the host closes the session store.
        const maximumBytes = Math.floor(
          (state.limits.resultBytes -
            state.counters.resultBytes +
            reads.reduce((sum, call) => sum + (state.calls[call.id]!.resultAllowance ?? 0), 0)) /
            reads.length,
        );
        const results = await Promise.allSettled(reads.map((call) => execute(call, maximumBytes)));
        for (const result of results)
          if (result.status === "fulfilled") await recordResult(result.value);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } else {
        const call = calls[i++]!;
        await recordResult(await execute(call));
        mutated ||= (state.calls[call.id]?.sideEffects ?? 0) > 0;
      }
    }

    return mutated;
  }
}
