import { boundText, type ToolDefinition } from "@vcli/core";
import type { CheckpointService } from "../workflows/checkpoints.ts";
import { objectSchema, stringSchema } from "./schema.ts";

export function createCheckpointTools(checkpoints: CheckpointService): ToolDefinition[] {
  return [
    {
      name: "checkpoint_list",
      description:
        "List the newest 100 file edit checkpoints for this session, including uncertain edits. Shell/MCP effects are not captured.",
      kind: "read",
      eager: false,
      inputSchema: objectSchema({}, []),
      async execute(_args, context) {
        const output = JSON.stringify(await checkpoints.list(context.sessionId), null, 2);
        return { text: boundText(output, 3_000), fullOutput: output };
      },
    },
    {
      name: "checkpoint_restore",
      description:
        "Rewind one completed built-in file edit by checkpoint ID. Refuses if the file was subsequently changed; newest edits must be restored first. Does not undo shell or external tool effects.",
      kind: "write",
      eager: false,
      inputSchema: objectSchema({ id: stringSchema }, ["id"]),
      execute: (args, context) => checkpoints.restore(String(args.id), context),
    },
  ];
}
