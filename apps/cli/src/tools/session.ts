import { boundText, type SessionStore, type ToolDefinition } from "@vcli/core";
import { lineNumberSchema, objectSchema, stringSchema } from "./schema.ts";
import type { BuiltinOptions } from "./types.ts";

export function createArtifactTool(store: SessionStore): ToolDefinition {
  return {
    name: "artifacts_read",
    description: "Retrieve a stored full tool result by opaque ID and line range.",
    kind: "read",
    inputSchema: objectSchema(
      { id: stringSchema, start: lineNumberSchema, end: lineNumberSchema },
      ["id"],
    ),
    async execute(args) {
      const content = await store.readArtifact(String(args.id));
      const lines = content.split("\n");
      const start = Number(args.start ?? 1);
      const end = Number(args.end ?? start + 199);
      if (end < start) throw new Error("end must be >=start");

      const output = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");
      return { text: boundText(output, 3_000) };
    },
  };
}

export function createLedgerTool(record: BuiltinOptions["record"]): ToolDefinition {
  return {
    name: "task_record",
    description:
      "Persist architecture decisions, constraints, and pending work across compaction. Verification is recorded from shell results.",
    kind: "read",
    inputSchema: objectSchema(
      {
        decisions: { type: "array", items: stringSchema },
        constraints: { type: "array", items: stringSchema },
        pending: { type: "array", items: stringSchema },
      },
      [],
    ),
    async execute(args) {
      await record?.(args);
      return { text: "Task ledger saved." };
    },
  };
}
