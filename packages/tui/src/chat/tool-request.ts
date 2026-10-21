import { escapeTerminalText as displayText, type ToolDefinition } from "@vcli/core";

export interface ToolRequest {
  name: string;
  title: string;
  effect: string;
  fields: { label: string; text: string; tone?: "removed" | "added" }[];
}

/** Presentation only: the permission gate still receives the original arguments. */
export function presentToolRequest(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): ToolRequest {
  const patch = tool.name === "files_patch";
  const command = tool.kind === "execute" && typeof args.command === "string";
  const labels: Record<string, string> = {
    path: "File or directory",
    command: "Command",
    oldText: "Before · exact text to replace",
    newText: patch && args.oldText === undefined ? "File content" : "After · replacement text",
    overwrite: "Replace entire existing file",
    timeoutMs: "Timeout (ms)",
    query: "Search for",
  };
  return {
    name: displayText(tool.name),
    title: patch ? "Review file change" : command ? "Review command" : "Review tool request",
    effect:
      tool.kind === "read"
        ? "Read-only action"
        : command
          ? "Runs a command · may change files or system state"
          : tool.kind === "execute"
            ? "Runs an external action · may change saved state"
            : "Changes files or saved state",
    fields: [
      { label: "Purpose", text: displayText(tool.description) },
      ...Object.entries(args).map(([key, value]) => ({
        label:
          labels[key] ?? displayText(key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")),
        text: displayValue(value),
        tone:
          patch && key === "oldText"
            ? ("removed" as const)
            : patch && key === "newText"
              ? ("added" as const)
              : undefined,
      })),
    ],
  };
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return displayText(value) || "(empty text)";
  if (value === null) return "(none)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => `• ${displayValue(item).replaceAll("\n", "\n  ")}`).join("\n")
      : "(empty list)";
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length
      ? entries
          .map(
            ([key, item]) => `${displayText(key)}: ${displayValue(item).replaceAll("\n", "\n  ")}`,
          )
          .join("\n")
      : "(empty object)";
  }
  return String(value);
}
