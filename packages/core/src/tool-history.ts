import type { ChatMessage, RuntimeEvent, Session, ToolKind } from "./contracts.ts";
import { boundText } from "./context.ts";

const toolEvents = new Set(["tool-request", "tool-start", "tool-end"]);
const sensitive =
  /^(?:.*[_-])?(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|token|headers|env)$/i;

/** Preserve text layout while making terminal instructions and direction overrides literal. */
export function escapeTerminalText(value: string): string {
  return value.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Tool history additionally masks recognizable credential assignments. */
export function displayToolText(value: string): string {
  return escapeTerminalText(value).replace(
    /\b((?:[a-z0-9_]*(?:api_key|access_token|refresh_token|password|secret)|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    "$1[redacted]",
  );
}

function argumentText(value: unknown, depth = 0): string {
  if (typeof value === "string")
    return boundText(displayToolText(value), 1000).replace(
      "retrieve the full artifact",
      "input preview shortened",
    );
  if (value === null) return "(none)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "object") return String(value);
  if (depth >= 3) return "[… nested input …]";
  const allEntries = Object.entries(value);
  const entries = allEntries.slice(0, 20);
  const text = entries
    .map(
      ([key, item]) =>
        `${displayToolText(key)}: ${sensitive.test(key) ? "[redacted]" : argumentText(item, depth + 1).replaceAll("\n", "\n  ")}`,
    )
    .join("\n");
  return (
    (text || (Array.isArray(value) ? "(empty list)" : "(empty object)")) +
    (allEntries.length > entries.length ? "\n[… more input fields …]" : "")
  );
}

function inputPreview(args: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    path: "File or directory",
    command: "Command",
    query: "Search",
    oldText: "Before",
    newText: "After",
    overwrite: "Replace entire file",
    timeoutMs: "Timeout (ms)",
  };
  const entries = Object.entries(args);
  const fields = entries
    .slice(0, 20)
    .map(
      ([key, value]) =>
        `${labels[key] ?? displayToolText(key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "))}:\n${sensitive.test(key) ? "[redacted]" : argumentText(value)}`,
    );
  if (entries.length > 20) fields.push("[… more input fields …]");
  return boundText(fields.join("\n\n"), 700).replace(
    "retrieve the full artifact",
    "input preview shortened",
  );
}

/** One card per call. Replaying starts/ends cannot append duplicates or reopen a terminal card. */
export function applyToolConversationEvent(chat: ChatMessage[], event: RuntimeEvent): boolean {
  if (!toolEvents.has(event.type)) return false;
  const callId = event.data.callId;
  if (typeof callId !== "string") return true;
  const id = `tool:${callId}`;
  let message = chat.find((item) => item.id === id && item.role === "tool");
  const args =
    event.data.arguments &&
    typeof event.data.arguments === "object" &&
    !Array.isArray(event.data.arguments)
      ? (event.data.arguments as Record<string, unknown>)
      : undefined;
  const kind = event.data.kind;
  if (!message) {
    message = {
      id,
      role: "tool",
      text: "",
      createdAt: event.time,
      status: "streaming",
      tool: {
        callId,
        name: displayToolText(String(event.data.name ?? "Tool")),
        input: "",
        state: "requested",
      },
    };
    chat.push(message);
  }
  const tool = message.tool!;
  if (kind === "read" || kind === "write" || kind === "execute") tool.kind = kind as ToolKind;
  if (args && !tool.input) {
    tool.input = inputPreview(args);
    const target = [args.path, args.command, args.query].find((value) => typeof value === "string");
    if (typeof target === "string")
      tool.target = boundText(displayToolText(target.replace(/\s+/g, " ")), 100)
        .replace(/\n/g, " ")
        .replace("retrieve the full artifact", "preview shortened");
  }
  if (event.type === "tool-end") {
    tool.state =
      event.data.interrupted === true
        ? "interrupted"
        : event.data.blocked === true
          ? "blocked"
          : event.data.isError === true
            ? "failed"
            : "complete";
    message.status =
      event.data.interrupted === true
        ? "aborted"
        : event.data.isError === true || event.data.blocked === true
          ? "failed"
          : "complete";
    message.text = boundText(
      displayToolText(
        String(event.data.result ?? "No output.").replace(/\nFull result: [^\n]+$/, ""),
      ),
      900,
    );
    if (typeof event.data.artifact === "string") tool.artifact = event.data.artifact;
  } else if (message.status === "streaming") {
    tool.state = event.type === "tool-start" ? "running" : tool.state;
  }
  return true;
}

/** Upgrade old presentation snapshots from recorded tool events, independent of compacted context. */
export function recoverToolConversation(session: Session, events: RuntimeEvent[]): void {
  const chat = (session.chat ??= []);
  const calls = new Map(
    session.messages.flatMap((message) => message.toolCalls ?? []).map((call) => [call.id, call]),
  );
  for (const event of events) {
    if (!toolEvents.has(event.type)) continue;
    const call = calls.get(String(event.data.callId));
    applyToolConversationEvent(
      chat,
      call && !event.data.arguments
        ? { ...event, data: { ...event.data, arguments: call.arguments } }
        : event,
    );
  }
  chat.sort((left, right) => {
    const a = Date.parse(left.createdAt),
      b = Date.parse(right.createdAt);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
  });
  session.chatToolsVersion = 1;
}
