import {
  inspectWorkflow,
  rewindCheckpoint,
  type WorkflowInspection,
} from "../workflows/inspection.ts";
import { confirm, print } from "../io.ts";
import type { CommandContext } from "./context.ts";

export async function workflowsCommand(
  topic: WorkflowInspection,
  action: string | undefined,
  args: string[],
  context: CommandContext,
) {
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
