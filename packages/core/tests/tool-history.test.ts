import { expect, test } from "bun:test";
import {
  applyToolConversationEvent,
  displayToolText,
  estimateTokens,
  type ChatMessage,
  type RuntimeEvent,
} from "../src/index.ts";

function event(type: RuntimeEvent["type"], data: RuntimeEvent["data"]): RuntimeEvent {
  return { type, data, sessionId: "fixture", time: "2026-10-13T12:00:00.000Z" };
}

test("tool conversation bounds and labels previews, masks credentials and preserves original arguments", () => {
  const chat: ChatMessage[] = [];
  const args = {
    path: "app.ts",
    oldText: "before",
    newText: "🧩 new code\n".repeat(800),
    apiKey: "private-key-fixture",
    headers: { Authorization: "private-header-fixture" },
    nested: { password: "nested-private-fixture" },
  };
  const original = JSON.stringify(args);
  applyToolConversationEvent(
    chat,
    event("tool-request", { callId: "one", name: "files_patch", kind: "write", arguments: args }),
  );
  expect(chat[0]?.tool).toMatchObject({
    name: "files_patch",
    state: "requested",
    target: "app.ts",
  });
  expect(chat[0]?.tool?.input).toContain("File or directory:");
  expect(chat[0]?.tool?.input).toContain("Before:\nbefore");
  expect(estimateTokens(chat[0]!.tool!.input)).toBeLessThanOrEqual(700);
  expect(chat[0]?.tool?.input).not.toContain("�");
  expect(JSON.stringify(chat)).not.toContain("private-key-fixture");
  expect(JSON.stringify(chat)).not.toContain("private-header-fixture");
  expect(JSON.stringify(chat)).not.toContain("nested-private-fixture");
  expect(JSON.stringify(args)).toBe(original);
  applyToolConversationEvent(
    chat,
    event("tool-end", {
      callId: "one",
      name: "files_patch",
      result: "actual output\n".repeat(2000),
      artifact: "full-handle",
      isError: false,
    }),
  );
  expect(estimateTokens(chat[0]!.text)).toBeLessThanOrEqual(900);
  expect(chat[0]?.tool?.artifact).toBe("full-handle");
});

test("tool replay upserts one card and cannot reopen completed effects", () => {
  const chat: ChatMessage[] = [];
  const start = event("tool-start", {
    callId: "one",
    name: "shell_run",
    arguments: { command: "printf ready" },
  });
  const end = event("tool-end", {
    callId: "one",
    name: "shell_run",
    result: "Exit 0\nready\nFull result: handle",
    artifact: "handle",
    isError: false,
  });
  for (const item of [start, start, end, end, start]) applyToolConversationEvent(chat, item);
  expect(chat).toHaveLength(1);
  expect(chat[0]).toMatchObject({
    text: "Exit 0\nready",
    status: "complete",
    tool: { state: "complete", artifact: "handle" },
  });
  expect(applyToolConversationEvent(chat, event("text", { text: "answer" }))).toBe(false);
});

test("validation-only, blocked and interrupted calls have terminal visible outcomes without execution starts", () => {
  const chat: ChatMessage[] = [];
  applyToolConversationEvent(
    chat,
    event("tool-end", {
      callId: "bad",
      name: "architecture_propose",
      result: "Invalid arguments",
      isError: true,
    }),
  );
  applyToolConversationEvent(
    chat,
    event("tool-end", {
      callId: "blocked",
      name: "architecture_propose",
      result: "Stopped after 3 invalid requests",
      isError: true,
      blocked: true,
    }),
  );
  applyToolConversationEvent(
    chat,
    event("tool-end", {
      callId: "interrupted",
      name: "files_patch",
      result: "Inspect state before retrying",
      isError: true,
      interrupted: true,
    }),
  );
  expect(chat.map((message) => message.tool?.state)).toEqual(["failed", "blocked", "interrupted"]);
  expect(chat.map((message) => message.status)).toEqual(["failed", "failed", "aborted"]);
});

test("tool display makes control codes visible and masks credential assignments", () => {
  expect(
    displayToolText(
      "hello\u001b[31m\u202etest\nOPENAI_API_KEY=private-fixture command\npassword: 'private password'",
    ),
  ).toBe("hello\\u001b[31m\\u202etest\nOPENAI_API_KEY=[redacted] command\npassword: [redacted]");
});
