import type { ProviderAdapter, ToolCall, ToolSchema } from "./contracts.ts";
import type {
  ManagedExecutor,
  ManagedJournal,
  ManagedRun,
  ManagedStore,
  RunCall,
  RunLimits,
  RunPlan,
  RunResult,
  RunTask,
} from "./managed-contracts.ts";
import { ToolRegistry, ToolValidationError } from "./tools.ts";
import { estimateTokens } from "./context.ts";

export const defaultRunLimits: RunLimits = {
  modelRequests: 30,
  toolCalls: 80,
  sideEffects: 20,
  resultBytes: 256 * 1024,
};

const outcome = {
  type: "object",
  additionalProperties: false,
  required: ["tool"],
  properties: {
    tool: {
      type: "string",
      enum: ["list_files", "read_file", "write_file", "delete_file", "Bash"],
    },
    contains: { type: "string", minLength: 1 },
    exitCode: { type: "integer" },
  },
};
export const managedControlSchemas: ToolSchema[] = [
  {
    name: "submit_plan",
    description:
      "Save a structured plan and stop for explicit human approval. Plan tasks need actual tool evidence, not claims.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "steps", "risks", "assumptions", "doneWhen"],
      properties: {
        goal: { type: "string", minLength: 1 },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description", "dependsOn", "tools", "outcome"],
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
              description: { type: "string", minLength: 1 },
              dependsOn: { type: "array", uniqueItems: true, items: { type: "string" } },
              tools: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: {
                  type: "string",
                  enum: ["list_files", "read_file", "write_file", "delete_file", "Bash"],
                },
              },
              outcome,
            },
          },
        },
        risks: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: { type: "string" } },
        doneWhen: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "complete_task",
    description:
      "Complete the current task using a recorded successful tool call from this task matching its outcome. The runtime verifies the evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["evidence_call_id"],
      properties: { evidence_call_id: { type: "string", minLength: 1 } },
    },
  },
];

const bytes = (text: string) => new TextEncoder().encode(text).length;
export function boundRunResult(result: RunResult, limit: number): RunResult {
  if (bytes(result.text) <= limit && !result.truncated) return result;
  const marker = "[incomplete] ";
  const encoded = new TextEncoder().encode(marker + result.text);
  // fatal decoding avoids introducing a replacement character beyond the byte budget.
  let end = Math.min(limit, encoded.length);
  let text = "";
  while (end > 0) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
      break;
    } catch {
      end--;
    }
  }
  return { ...result, text, truncated: true };
}
function signature(call: ToolCall): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value;
  return JSON.stringify([call.name, stable(call.arguments)]);
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const time = () => new Date().toISOString();

export interface ManagedRuntimeOptions {
  provider: ProviderAdapter;
  executor: ManagedExecutor;
  journal: ManagedJournal;
  store: ManagedStore;
  instructions?: () => Promise<string>;
  /** Test-only crash injection. It intentionally bypasses normal tool-error handling. */
  fault?: (
    point: "after-budget" | "after-start" | "after-effect" | "after-model-budget",
    run: ManagedRun,
    call?: RunCall,
  ) => void | Promise<void>;
}

/** Durable state machine. All effects stay behind separately injected policy/executor services. */
export class ManagedRuntime {
  private readonly control = new ToolRegistry();
  constructor(private readonly options: ManagedRuntimeOptions) {
    for (const schema of managedControlSchemas)
      this.control.register({ ...schema, kind: "read", execute: async () => ({ text: "" }) });
  }
  async create(values: {
    id: string;
    root: string;
    policyPath: string;
    goal: string;
    mode?: "safe" | "auto";
    plan?: boolean;
    limits?: Partial<RunLimits>;
  }): Promise<ManagedRun> {
    const limits = { ...defaultRunLimits, ...values.limits };
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} limit.`);
    const tree = await this.options.journal.capture();
    const run: ManagedRun = {
      version: 1,
      revision: 0,
      id: values.id,
      root: values.root,
      policyPath: values.policyPath,
      goal: values.goal,
      mode: values.mode ?? "safe",
      phase: values.plan ? "planning" : "execution",
      status: "running",
      messages: [{ role: "user", text: values.goal }],
      limits,
      spent: { modelRequests: 0, toolCalls: 0, sideEffects: 0, resultBytes: 0 },
      calls: [],
      batch: [],
      batchIndex: 0,
      journal: { initial: tree, expected: tree, changes: [] },
      tokenBudget: { limit: 256_000, spent: 0 },
    };
    await this.options.store.save(run);
    return run;
  }
  private save(run: ManagedRun) {
    return this.options.store.save(run);
  }
  private kind(call: ToolCall) {
    return this.control.get(call.name) ? "control" : this.options.executor.kind(call.name);
  }
  private effect(call: ToolCall) {
    return ["write", "delete", "bash"].includes(this.kind(call));
  }
  private validate(call: ToolCall) {
    if (!call.id || typeof call.id !== "string") throw new Error("Missing tool_call_id.");
    if (this.control.get(call.name)) this.control.validate(call);
    else this.options.executor.validate(call);
  }
  private budget(run: ManagedRun, cost: Partial<RunLimits>): boolean {
    for (const key of Object.keys(cost) as (keyof RunLimits)[])
      if (run.spent[key] + cost[key]! > run.limits[key]) {
        run.status = "budget";
        run.error = `Budget exhausted: ${key}`;
        return false;
      }
    for (const key of Object.keys(cost) as (keyof RunLimits)[]) run.spent[key] += cost[key]!;
    return true;
  }
  private resultRemaining(run: ManagedRun) {
    return run.limits.resultBytes - run.spent.resultBytes;
  }
  private async finish(run: ManagedRun, record: RunCall, value: RunResult): Promise<void> {
    const result = boundRunResult(value, this.resultRemaining(run));
    record.state = "complete";
    record.result = result;
    run.spent.resultBytes += bytes(result.text);
    run.messages.push({
      role: "tool",
      toolCallId: record.call.id,
      toolName: record.call.name,
      text: result.text,
    });
    run.batchIndex++;
    await this.save(run);
  }
  private currentTask(run: ManagedRun): RunTask | undefined {
    if (!run.plan || run.phase === "planning") return undefined;
    const tasks = run.plan.steps;
    const active = tasks.find((task) => task.state === "active");
    if (active) return active;
    const next = tasks.find(
      (task) =>
        task.state === "pending" &&
        task.dependsOn.every(
          (id) => tasks.find((dependency) => dependency.id === id)?.state === "complete",
        ),
    );
    if (next) next.state = "active";
    return next;
  }
  private async controlCall(run: ManagedRun, record: RunCall): Promise<RunResult> {
    const args = record.call.arguments;
    if (record.call.name === "submit_plan") {
      if (run.phase !== "planning" || run.planDecision)
        throw new Error("Plans can only be submitted in planning before approval.");
      const plan = structuredClone(args) as unknown as RunPlan;
      const ids = new Set(plan.steps.map((task) => task.id));
      if (ids.size !== plan.steps.length) throw new Error("Duplicate task identifiers.");
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const visit = (task: RunTask) => {
        if (visiting.has(task.id)) throw new Error("Task dependency cycle.");
        if (visited.has(task.id)) return;
        if (!task.tools.includes(task.outcome.tool))
          throw new Error("Task outcome tool must belong to its tools.");
        if (task.outcome.tool === "Bash" && task.outcome.exitCode !== 0)
          throw new Error("Bash evidence must require exitCode 0.");
        visiting.add(task.id);
        for (const id of task.dependsOn) {
          const dependency = plan.steps.find((entry) => entry.id === id);
          if (!dependency) throw new Error(`Unknown task dependency: ${id}`);
          visit(dependency);
        }
        visiting.delete(task.id);
        visited.add(task.id);
        task.state = "pending";
      };
      for (const task of plan.steps) visit(task);
      run.plan = plan;
      run.status = "waiting-plan";
      return { text: "Plan saved. Waiting for explicit human approval." };
    }
    if (run.phase !== "execution") throw new Error("Cannot complete tasks in planning.");
    const task = this.currentTask(run);
    if (!task) throw new Error("No active task.");
    const evidence = run.calls.find((entry) => entry.call.id === args.evidence_call_id);
    if (
      !evidence ||
      evidence.taskId !== task.id ||
      evidence.state !== "complete" ||
      !evidence.result ||
      evidence.result.isError ||
      evidence.result.truncated ||
      evidence.call.name !== task.outcome.tool
    )
      throw new Error("Task requires successful, complete evidence from its own outcome tool.");
    if (task.outcome.exitCode !== undefined && evidence.result.exitCode !== task.outcome.exitCode)
      throw new Error("Task evidence has the wrong exit code.");
    if (task.outcome.contains && !evidence.result.text.includes(task.outcome.contains))
      throw new Error("Task evidence does not satisfy the expected result.");
    task.state = "complete";
    task.evidence = { callId: evidence.call.id, text: evidence.result.text };
    return { text: `Verified task ${task.id}` };
  }
  async advance(run: ManagedRun, signal: AbortSignal): Promise<ManagedRun> {
    if (run.calls.some((call) => call.state === "started" || call.state === "uncertain")) {
      for (const call of run.calls) if (call.state === "started") call.state = "uncertain";
      run.status = "uncertain";
      await this.save(run);
      return run;
    }
    if (run.status !== "running") return run;
    if (run.schemaErrors?.some((entry) => entry.count >= 3)) {
      run.status = "failed";
      run.error =
        "Stopped after three schema errors for one tool. Start a new human task to reset the guard.";
      await this.save(run);
      return run;
    }
    const { provider, executor, journal } = this.options;
    const instructions = await this.options.instructions?.();
    if (run.provider && (run.provider.id !== provider.id || run.provider.model !== provider.model))
      run.messages = run.messages.map((message) => ({ ...message, providerData: undefined }));
    run.provider = { id: provider.id, model: provider.model };
    while (run.status === "running") {
      signal.throwIfAborted();
      while (run.batchIndex < run.batch.length && run.status === "running") {
        const call = run.batch[run.batchIndex]!;
        const existing = run.calls.find((entry) => entry.call.id === call.id)!;
        if (signature(existing.call) !== signature(call)) {
          // Do not overwrite the original call identity/result on a protocol violation.
          const mismatch: RunCall = {
            call,
            phase: run.phase,
            state: "pending",
            attempts: 0,
            decisions: [],
          };
          await this.finish(run, mismatch, {
            text: "Protocol error: tool_call_id was reused with different name or arguments.",
            isError: true,
          });
          continue;
        }
        if (existing.state === "complete") {
          const cached = existing.result!;
          const replay = boundRunResult(cached, this.resultRemaining(run));
          run.spent.resultBytes += bytes(replay.text);
          run.messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            text: replay.text,
          });
          run.batchIndex++;
          await this.save(run);
          continue;
        }
        if (this.resultRemaining(run) <= 0) {
          run.status = "budget";
          run.error = "Budget exhausted: resultBytes";
          await this.save(run);
          break;
        }
        let result: RunResult;
        try {
          if (run.plan && run.phase === "execution" && existing.phase === "execution")
            existing.taskId = this.currentTask(run)?.id;
          this.validate(call);
          run.schemaErrors = run.schemaErrors?.filter((entry) => entry.tool !== call.name);
          if ((run.phase === "planning" || existing.phase === "planning") && this.effect(call))
            throw new Error(
              "Plan mode forbids file mutation, deletion and Bash before explicit plan approval. Calls proposed in planning cannot be carried across approval.",
            );
          if (this.kind(call) !== "control") await executor.check(call);
          if (run.plan && run.phase === "execution" && existing.phase === "execution") {
            const task = this.currentTask(run);
            if (!task) throw new Error("All tasks are complete; return a final answer.");
            if (this.kind(call) !== "control" && !task.tools.includes(call.name))
              throw new Error(`Tool not permitted for current task ${task.id}.`);
            existing.taskId = task.id;
          }
          if (this.effect(call)) {
            if (existing.approval === "deny")
              throw new Error("Human declined this action. Choose another action.");
            if (!existing.approval && (run.mode === "safe" || this.kind(call) === "delete")) {
              run.status = "waiting-approval";
              await this.save(run);
              break;
            }
            await journal.before(run);
          }
        } catch (error) {
          if (error instanceof ToolValidationError) {
            run.schemaErrors ??= [];
            const entry = run.schemaErrors.find((entry) => entry.tool === call.name);
            if (entry) entry.count++;
            else run.schemaErrors.push({ tool: call.name, count: 1 });
          }
          await this.finish(run, existing, { text: errorText(error), isError: true });
          if (run.schemaErrors?.some((entry) => entry.count >= 3)) {
            run.status = "failed";
            run.error = "Stopped after three repeated tool schema errors.";
            await this.save(run);
          }
          continue;
        }
        existing.state = "started";
        existing.attempts++;
        await this.save(run);
        await this.options.fault?.("after-start", run, existing);
        try {
          result =
            this.kind(call) === "control"
              ? await this.controlCall(run, existing)
              : await executor.execute(call, this.resultRemaining(run), signal);
        } catch (error) {
          result = { text: errorText(error), isError: true };
        }
        await this.options.fault?.("after-effect", run, existing);
        // A bookkeeping failure leaves a started call, never a false failed edit.
        if (this.effect(call)) await journal.after(run);
        await this.finish(run, existing, result);
      }
      if (run.status !== "running") break;
      run.batch = [];
      run.batchIndex = 0;
      const task = this.currentTask(run);
      const system = [
        "You are a coding agent. Choose tools yourself; inspect files, fix the goal, verify with Bash, then return a final answer. Never modify tests when the goal forbids it.",
        "Every tool call is untrusted and independently validated. Tool errors are recoverable; do not repeat invalid calls unchanged.",
        instructions ?? "",
        run.phase === "planning"
          ? "Planning: only read tools are permitted. Submit a structured plan using submit_plan and wait for approval. Include inspection, implementation and verification tasks with dependencies and verifiable outcomes."
          : "Execution: use permitted tools; safe mode stops for each write/Bash approval and deletion always stops.",
        task
          ? `Current task: ${JSON.stringify(task)}. Use complete_task with evidence_call_id of an actual successful call belonging to this task. Dependencies are runtime enforced.`
          : "",
        run.plan ? `Plan: ${JSON.stringify(run.plan)}` : "",
        `Budget remaining: ${JSON.stringify(Object.fromEntries(Object.keys(run.limits).map((key) => [key, run.limits[key as keyof RunLimits] - run.spent[key as keyof RunLimits]])))}`,
      ].join("\n");
      const schemas = [...executor.schemas, ...managedControlSchemas];
      const inputTokens = estimateTokens(
        system + JSON.stringify(run.messages) + JSON.stringify(schemas),
      );
      const outputTokens = Math.min(4096, Math.floor((provider.contextWindow || 32768) / 4));
      const reservation = inputTokens + outputTokens;
      run.tokenBudget ??= { limit: 256_000, spent: 0 };
      if (
        reservation > (provider.contextWindow || 32768) ||
        run.tokenBudget.spent + reservation > run.tokenBudget.limit
      ) {
        run.status = "budget";
        run.error = "Budget exhausted: model token/context window";
        await this.save(run);
        break;
      }
      if (!this.budget(run, { modelRequests: 1 })) {
        await this.save(run);
        break;
      }
      run.tokenBudget.spent += reservation;
      await this.save(run);
      await this.options.fault?.("after-model-budget", run);
      const calls: ToolCall[] = [];
      let text = "";
      let providerData: unknown;
      let measuredTokens: number | undefined;
      try {
        for await (const event of provider.stream(
          { system, messages: run.messages, tools: schemas, maxOutputTokens: outputTokens },
          signal,
        )) {
          if (event.type === "tool-call") calls.push(event.call);
          if (event.type === "text") text += event.text;
          if (event.type === "done") providerData = event.providerData;
          if (
            event.type === "usage" &&
            Number.isSafeInteger(event.usage.input) &&
            event.usage.input >= 0 &&
            Number.isSafeInteger(event.usage.output) &&
            event.usage.output >= 0 &&
            event.usage.input + event.usage.output > 0
          )
            measuredTokens = event.usage.input + event.usage.output;
        }
      } catch (error) {
        run.status = "failed";
        run.error = errorText(error);
        await this.save(run);
        throw error;
      }
      if (measuredTokens !== undefined) run.tokenBudget.spent += measuredTokens - reservation;
      run.messages.push({
        role: "assistant",
        text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(providerData !== undefined ? { providerData } : {}),
      });
      if (!calls.length) {
        if (run.phase === "planning") {
          run.status = "failed";
          run.error = "Planning requires a structured submit_plan call.";
        } else if (run.plan?.steps.some((entry) => entry.state !== "complete")) {
          run.status = "failed";
          run.error = "Final answer cannot complete unverified tasks.";
        } else run.status = "complete";
        await this.save(run);
        break;
      }
      // Reserve the entire batch atomically, including potential effects. No prefix executes.
      const newEffects = calls.filter(
        (call) => !run.calls.some((entry) => entry.call.id === call.id) && this.effect(call),
      ).length;
      if (
        !this.budget(run, { toolCalls: calls.length, sideEffects: newEffects }) ||
        this.resultRemaining(run) <= 0
      ) {
        run.status = "budget";
        run.error ??= "Budget exhausted: resultBytes";
        await this.save(run);
        break;
      }
      run.batch = calls;
      run.batchIndex = 0;
      for (const call of calls)
        if (!run.calls.some((entry) => entry.call.id === call.id))
          run.calls.push({ call, phase: run.phase, state: "pending", attempts: 0, decisions: [] });
      await this.save(run);
      await this.options.fault?.("after-budget", run);
    }
    return run;
  }
  async approveAction(run: ManagedRun, decision: "allow" | "deny"): Promise<void> {
    if (run.status !== "waiting-approval") throw new Error("No action is waiting for approval.");
    const call = run.calls.find((entry) => entry.call.id === run.batch[run.batchIndex]?.id);
    if (!call || call.state !== "pending") throw new Error("Invalid pending approval.");
    call.approval = decision;
    call.decisions.push({ action: decision, time: time() });
    run.status = "running";
    await this.save(run);
  }
  async approvePlan(run: ManagedRun, decision: "approve" | "reject"): Promise<void> {
    if (run.status !== "waiting-plan" || !run.plan)
      throw new Error("No plan is waiting for approval.");
    run.planDecision = decision;
    run.status = decision === "approve" ? "running" : "rejected";
    if (decision === "approve") run.phase = "execution";
    await this.save(run);
  }
  async resolve(
    run: ManagedRun,
    callId: string,
    decision: "retry" | "fail" | "abort",
    adopt = false,
  ): Promise<void> {
    const call = run.calls.find((entry) => entry.call.id === callId);
    if (!call || !["started", "uncertain"].includes(call.state))
      throw new Error("No uncertain call with that ID.");
    if (decision === "abort") {
      call.decisions.push({ action: "abort", time: time() });
      run.status = "failed";
      run.error = "Human terminated an uncertain run.";
      await this.save(run);
      return;
    }
    if (decision === "retry") {
      // Only reads are safely repeatable. Bash may mutate hidden host state even if tree is unchanged.
      if (this.kind(call.call) !== "read")
        throw new Error(
          "Only read tools are safely repeatable; mutations and Bash must be failed or aborted.",
        );
      if (!this.budget(run, { toolCalls: 1 })) {
        await this.save(run);
        return;
      }
      call.state = "pending";
      call.decisions.push({ action: "retry", time: time() });
    } else {
      const current = await this.options.journal.capture();
      const treeIdentity = (tree: ManagedRun["journal"]["expected"]) =>
        JSON.stringify(
          Object.keys(tree)
            .sort()
            .map((path) => [path, tree[path]!.hash, tree[path]!.mode]),
        );
      if (treeIdentity(current) !== treeIdentity(run.journal.expected) && !adopt)
        throw new Error(
          "Tree changed during the uncertain action. Inspect diff and explicitly adopt these changes, or abort.",
        );
      if (adopt) await this.options.journal.after(run);
      call.decisions.push({ action: adopt ? "fail-and-adopt" : "fail", time: time() });
      await this.finish(run, call, {
        text: "Human marked the uncertain attempt unsuccessful; it was not replayed.",
        isError: true,
      });
    }
    run.status = run.calls.some((entry) => entry.state === "started" || entry.state === "uncertain")
      ? "uncertain"
      : "running";
    await this.save(run);
  }
  async resumeFailure(run: ManagedRun): Promise<void> {
    if (
      run.status === "failed" &&
      !run.calls.some((entry) => entry.state === "started" || entry.state === "uncertain")
    ) {
      run.status = "running";
      delete run.error;
      await this.save(run);
    }
  }
}

export function taskChecklist(run: ManagedRun): string {
  return (
    run.plan?.steps
      .map(
        (task) =>
          `[${task.state === "complete" ? "x" : " "}] ${task.id}: ${task.description}${task.state === "active" ? " (active)" : ""}${task.evidence ? ` — evidence ${task.evidence.callId}` : ""}`,
      )
      .join("\n") ?? "No approved task plan."
  );
}
