import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

/** Exercise cancellation through real terminal bytes, a stalled SDK request and SQLite. */
export async function cancellationSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-cancel-"));
  let requests = 0;
  let received!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    received = resolve;
  });
  let releaseHeaders!: () => void;
  const headers = new Promise<void>((resolve) => {
    releaseHeaders = resolve;
  });
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = requests++;
      if (turn === 0) {
        received();
        await headers;
      }
      if (turn === 2)
        return new Response(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "cancel-edit",
                type: "function",
                function: {
                  name: "files_patch",
                  arguments: JSON.stringify({
                    path: "app.ts",
                    oldText: "value = 1",
                    newText: "value = 2",
                  }),
                },
              },
            ],
          }) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      if (turn >= 4)
        return new Response(
          chunk({ content: "Chat works after cancellation." }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk({
                  content: turn === 1 ? "Partial response preserved." : "Stop command response.",
                }),
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let terminal: ReturnType<typeof createWorkspaceTerminal> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(join(root, ".vcli"));
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "cancel-fixture",
        baseURL: server.url.origin,
        permission: "ask",
      }),
    );
    await writeFile(join(root, "app.ts"), "export const value = 1;\n");
    terminal = createWorkspaceTerminal({
      command,
      cwd: root,
      env: {
        VCLI_CONFIG_HOME: join(root, "configuration"),
        VCLI_COMPATIBLE_API_KEY: "local-fixture-key",
      },
    });
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("Cancel before response headers", "Waiting for model");
    await Promise.race([
      firstRequest,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Provider request was not received")), 5000);
      }),
    ]);
    clearTimeout(watchdog);
    await terminal.waitFor("Task canceled.", terminal.write("\u0003"), 3000);
    releaseHeaders();
    await terminal.submit("Cancel the partial stream", "Partial response preserved.");
    await terminal.waitFor("Task canceled.", terminal.write("\u001b[1089::99;5u"), 3000);
    await terminal.submit("Cancel the pending edit", "Permission needed");
    await terminal.waitFor("Task canceled.", terminal.write("\u0003"), 3000);
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
      throw new Error("Canceling approval executed the pending edit");
    await terminal.submit("Cancel using a slash command", "Stop command response.");
    await terminal.submit("/stop", "Task canceled.");
    const store = await SqliteSessionStore.open(root);
    try {
      const current = (await store.list())[0];
      if (
        current?.status !== "aborted" ||
        !current.chat?.some(
          (message) =>
            message.text.includes("Partial response preserved.") && message.status === "aborted",
        )
      )
        throw new Error("Cancellation or partial text was not persisted");
    } finally {
      store.close();
    }
    await terminal.submit("Continue in the same chat", "Chat works after cancellation.");
    await terminal.waitFor("Ready");
    if (requests !== 5) throw new Error(`Cancellation triggered extra model requests: ${requests}`);
    await terminal.quit();
    return {
      requests,
      headersCanceled: true,
      nonLatinShortcut: true,
      approvalCanceled: true,
      stopCommand: true,
      partialPersisted: true,
      chatReusable: true,
    };
  } finally {
    clearTimeout(watchdog);
    releaseHeaders();
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
