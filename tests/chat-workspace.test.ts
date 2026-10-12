import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chatSmoke } from "../scripts/smoke-chat.ts";

test("real terminal chat echoes prompts, renders Markdown, switches conversations and restores history", async () => {
  const result = await chatSmoke([
    process.execPath,
    resolve(import.meta.dir, "../apps/cli/src/index.ts"),
  ]);
  expect(result).toEqual({
    modelRequests: 3,
    formattedChat: true,
    persistedHistory: true,
    terminalRestored: true,
  });
}, 50_000);
