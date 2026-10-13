import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chatSmoke } from "../scripts/smoke-chat.ts";
import { approvalSmoke } from "../scripts/smoke-approval.ts";

test("real terminal permission cards gate file changes and return decisions to the model", async () => {
  expect(
    await approvalSmoke([process.execPath, resolve(import.meta.dir, "../apps/cli/src/index.ts")]),
  ).toEqual({
    requests: 4,
    readableApproval: true,
    deniedEditPreserved: true,
    allowedEditApplied: true,
  });
}, 50_000);

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
