import type { ToolDefinition } from "@vcli/core";
import type { SubagentService } from "../workflows/subagents.ts";
import { objectSchema } from "./schema.ts";

export function createSubagentTool(service: SubagentService): ToolDefinition {
  return {
    name: "subagent_explore",
    kind: "read",
    eager: false,
    description:
      "Delegate a bounded read-only repository research/review task to an isolated model explorer. Up to two run concurrently; no writes, shell, or nested delegation. Returns findings and child session; full transcript is retained as an artifact. Tokens count toward the parent budget. Use direct reads for simple questions.",
    inputSchema: objectSchema(
      {
        prompt: { type: "string", minLength: 1, maxLength: 16000 },
        tokens: { type: "integer", minimum: 4000, maximum: 24000 },
      },
      ["prompt"],
    ),
    async execute(args, context) {
      const result = await service.explore(
        String(args.prompt),
        context.sessionId,
        context.signal,
        args.tokens === undefined ? undefined : Number(args.tokens),
      );
      return {
        text: result.summary,
        fullOutput: result.transcript,
        details: { subagentId: result.id, sessionId: result.sessionId, status: result.status },
        isError: result.status !== "complete",
      };
    },
  };
}
