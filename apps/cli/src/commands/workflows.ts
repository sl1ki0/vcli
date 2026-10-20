import {
  inspectWorkflow,
  rewindCheckpoint,
  type WorkflowInspection,
} from "../workflows/inspection.ts";
import { confirm, print } from "../io.ts";
import type { CommandContext } from "./context.ts";
import { decidePlan, withRun } from "../workflows/run-controls.ts";
import { runOptions } from "../run-options.ts";
import { formatRunPlan } from "../workflows/plans.ts";

export async function workflowsCommand(
  topic: WorkflowInspection,
  action: string | undefined,
  args: string[],
  context: CommandContext,
) {
  if (topic === "plan" && ["approve", "reject"].includes(action ?? "")) {
    if (!args[0]) throw new Error("Run ID required: vcli plan approve|reject <run_id>");
    const session = await decidePlan(
      context.root,
      args[0],
      action === "approve",
      runOptions(context.values),
    );
    await print(formatRunPlan(session.plan!, session.id));
    return;
  }
  if (topic === "plan" && args[0]) {
    if (action && !["show", "list"].includes(action))
      throw new Error(`Unknown plan action: ${action}`);
    await withRun(context.root, args[0], runOptions(context.values), async (session) => {
      if (!session.plan) throw new Error("No structured plan in this run.");
      await print(
        context.values.json
          ? { run_id: session.id, plan: session.plan }
          : formatRunPlan(session.plan, session.id),
      );
    });
    return;
  }
  if (topic === "checkpoints" && action === "restore") {
    if (!args[0]) throw new Error("Checkpoint ID required. Use vcli checkpoints list.");
    const result = await rewindCheckpoint(
      context.root,
      args[0],
      context.values.plan ? "read-only" : context.config.permission,
      (tool, input) => confirm(tool, input, new AbortController().signal),
    );
    await print(context.values.json ? JSON.stringify({ result }) : result);
    return;
  }
  if (action && !["list", "show"].includes(action))
    throw new Error(`Unknown ${topic} action: ${action}`);
  const content = await inspectWorkflow(context.root, topic);
  await print(context.values.json ? JSON.stringify({ topic, content }) : content);
}
