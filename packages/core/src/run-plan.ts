import type { ToolResult } from "./contracts.ts";

export interface RunPlanStepInput {
  id: string;
  description: string;
  dependencies: string[];
  tools: string[];
  doneWhen: string;
  /** A successful, recorded call of this tool is required before completing the task. */
  verificationTool: string;
}

export interface RunPlanInput {
  goal: string;
  steps: RunPlanStepInput[];
  risks: string[];
  assumptions: string[];
  doneWhen: string;
}

export interface RunTaskEvidence {
  callId: string;
  tool: string;
  succeeded: boolean;
  summary: string;
}

export interface RunPlanTask extends RunPlanStepInput {
  status: "pending" | "in-progress" | "complete";
  evidence: RunTaskEvidence[];
  verifiedBy?: string[];
}

export interface RunPlanState extends Omit<RunPlanInput, "steps"> {
  steps: RunPlanTask[];
  status: "draft" | "approved" | "rejected";
  createdAt: string;
  decisionAt?: string;
  currentTaskId?: string;
}

function text(value: unknown, name: string, limit: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(`${name} must contain 1–${limit} characters.`);
}

function strings(value: unknown, name: string, limit = 20): asserts value is string[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(`${name} must be an array of at most ${limit} strings.`);
  for (const item of value) text(item, name, 500);
  if (new Set(value).size !== value.length) throw new Error(`${name} contains duplicates.`);
}

/** Reject malformed graphs before publishing; ordering is retained for chat and execution. */
export function validateRunPlan(input: RunPlanInput): void {
  text(input.goal, "Plan goal", 1000);
  text(input.doneWhen, "Plan completion criterion", 1000);
  strings(input.risks, "Plan risks");
  strings(input.assumptions, "Plan assumptions");
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 50)
    throw new Error("A plan must contain 1–50 tasks.");
  const ids = new Set<string>();
  for (const step of input.steps) {
    if (!step || typeof step !== "object") throw new Error("Invalid plan task.");
    text(step.id, "Task ID", 80);
    if (!/^[\w.-]+$/.test(step.id)) throw new Error("Task IDs use letters, digits, _, . or -.");
    if (ids.has(step.id)) throw new Error(`Duplicate task ID: ${step.id}`);
    ids.add(step.id);
    text(step.description, "Task description", 1000);
    text(step.doneWhen, "Task completion criterion", 1000);
    strings(step.dependencies, "Task dependencies", 50);
    strings(step.tools, "Task tools");
    text(step.verificationTool, "Task verification tool", 100);
    if (["plan_publish", "plan_task", "tools_search"].includes(step.verificationTool))
      throw new Error(`Task ${step.id}: metadata tools cannot verify a result.`);
    if (!step.tools.includes(step.verificationTool))
      throw new Error(`Task ${step.id}: verification tool must be listed in tools.`);
  }
  const byId = new Map(input.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error("Plan task dependencies contain a cycle.");
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)!.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown task dependency: ${dependency}`);
      visit(dependency);
    }
    active.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
}

export function createRunPlan(
  input: RunPlanInput,
  mode: "plan" | "build",
  time = new Date().toISOString(),
): RunPlanState {
  validateRunPlan(input);
  return {
    ...input,
    risks: [...input.risks],
    assumptions: [...input.assumptions],
    steps: input.steps.map((step) => ({
      ...step,
      dependencies: [...step.dependencies],
      tools: [...step.tools],
      status: "pending",
      evidence: [],
    })),
    status: mode === "plan" ? "draft" : "approved",
    createdAt: time,
    ...(mode === "build" ? { decisionAt: time } : {}),
  };
}

export function decideRunPlan(
  plan: RunPlanState,
  approved: boolean,
  time = new Date().toISOString(),
): void {
  if (plan.status !== "draft") throw new Error("Only a draft plan can be approved or rejected.");
  plan.status = approved ? "approved" : "rejected";
  plan.decisionAt = time;
}

/** Runtime selection cannot skip dependencies or restart a completed task after resume. */
export function currentPlanTask(plan: RunPlanState, requestedTaskId?: string): RunPlanTask {
  if (plan.status !== "approved") throw new Error("The plan requires explicit approval first.");
  const id = requestedTaskId ?? plan.currentTaskId;
  const task = id
    ? plan.steps.find((step) => step.id === id)
    : plan.steps.find(
        (step) =>
          step.status !== "complete" &&
          step.dependencies.every(
            (dependency) =>
              plan.steps.find((item) => item.id === dependency)?.status === "complete",
          ),
      );
  if (!task) throw new Error(id ? `Unknown plan task: ${id}` : "All plan tasks are complete.");
  if (task.status === "complete") throw new Error(`Task ${task.id} is already complete.`);
  const blocked = task.dependencies.filter(
    (dependency) => plan.steps.find((step) => step.id === dependency)?.status !== "complete",
  );
  if (blocked.length)
    throw new Error(`Task ${task.id} is blocked by unfinished dependencies: ${blocked.join(", ")}`);
  return task;
}

export function startPlanTask(plan: RunPlanState, requestedTaskId?: string): RunPlanTask {
  const task = currentPlanTask(plan, requestedTaskId);
  task.status = "in-progress";
  plan.currentTaskId = task.id;
  return task;
}

/** Evidence is derived exclusively from runtime outcomes; model-supplied summaries cannot verify. */
export function recordPlanToolResult(
  plan: RunPlanState,
  taskId: string,
  callId: string,
  tool: string,
  result: Pick<ToolResult, "text" | "isError" | "outcomeUncertain">,
): void {
  const task = plan.steps.find((step) => step.id === taskId);
  if (!task || task.status === "complete") return;
  if (task.evidence.some((item) => item.callId === callId)) return;
  task.evidence.push({
    callId,
    tool,
    succeeded: result.isError !== true && result.outcomeUncertain !== true,
    summary: result.text.slice(0, 300),
  });
}

export function verifyPlanTask(
  plan: RunPlanState,
  taskId: string,
  evidenceCallIds: string[],
): RunPlanTask {
  const task = currentPlanTask(plan, taskId);
  if (!Array.isArray(evidenceCallIds) || !evidenceCallIds.length)
    throw new Error("Task completion requires recorded tool-call evidence.");
  const evidence = evidenceCallIds.map((id) => task.evidence.find((item) => item.callId === id));
  if (evidence.some((item) => !item || !item.succeeded))
    throw new Error("Task verification requires successful calls recorded for this task.");
  if (!evidence.some((item) => item?.tool === task.verificationTool))
    throw new Error(`Task verification requires a successful ${task.verificationTool} result.`);
  task.status = "complete";
  task.verifiedBy = [...new Set(evidenceCallIds)];
  if (plan.currentTaskId === taskId) delete plan.currentTaskId;
  return task;
}

export function unfinishedPlanTasks(plan: RunPlanState): RunPlanTask[] {
  return plan.steps.filter((step) => step.status !== "complete");
}
