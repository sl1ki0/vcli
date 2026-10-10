import { createInterface } from "node:readline/promises";
import type { ArchitectureGraph, ToolDefinition } from "@vcli/core";
export function print(value: unknown): void {
  console.log(
    typeof value === "string"
      ? value
      : JSON.stringify(
          value,
          (key, data: unknown) => {
            if ((key === "headers" || key === "env") && data && typeof data === "object")
              return Object.fromEntries(Object.keys(data).map((name) => [name, "[configured]"]));
            if (/^(apiKey|authorization|password|secret|token)$/i.test(key)) return "[configured]";
            return data;
          },
          2,
        ),
  );
}
export function printTree(graph: ArchitectureGraph): string {
  return [
    `${graph.root} · ${graph.nodes.length} nodes · ${graph.edges.length} relations`,
    ...graph.nodes
      .filter((n) => n.kind !== "external")
      .map((n) => `${n.parent ? "  " : ""}${n.label}${n.path ? ` (${n.path})` : ""}`),
    ...graph.diagnostics.map((d) => `! ${d}`),
  ].join("\n");
}
export async function confirm(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test(
      (
        await reader.question(`Allow ${tool.name} ${JSON.stringify(args).slice(0, 700)}? [y/N] `, {
          signal,
        })
      ).trim(),
    );
  } finally {
    reader.close();
  }
}
