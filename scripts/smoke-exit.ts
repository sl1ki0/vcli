import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

/** Exit from idle chat, a stalled provider stream and a pending tool approval. */
export async function exitSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-exit-"));
  let requests = 0;
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      if (requests++ === 0)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(chunk({ content: "Partial answer before exit." })),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "exit-edit",
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
    },
  });
  let terminal: ReturnType<typeof createWorkspaceTerminal> | undefined;
  try {
    await mkdir(join(root, ".vcli"));
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "exit-fixture",
        baseURL: server.url.origin,
        permission: "ask",
      }),
    );
    await writeFile(join(root, "app.ts"), "export const value = 1;\n");
    const options = {
      command,
      cwd: root,
      env: {
        VCLI_CONFIG_HOME: join(root, "configuration"),
        VCLI_COMPATIBLE_API_KEY: "local-fixture-key",
      },
    };
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.quit("/exit");
    await terminal.close();
    if (requests) throw new Error("Idle exit made a model call");
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("Exit during a partial response", "Partial answer before exit.");
    await terminal.quit("/quit");
    await terminal.close();
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("Exit while waiting for approval", "Permission needed");
    await terminal.waitFor("/", terminal.write("/"));
    await terminal.quit("/exit");
    const store = await SqliteSessionStore.open(root);
    try {
      const sessions = await store.list();
      if (sessions.length !== 2 || sessions.some((session) => session.status !== "aborted"))
        throw new Error("Exit did not persist canceled sessions before closing");
      if (
        !sessions.some((session) =>
          session.chat?.some(
            (message) =>
              message.text === "Partial answer before exit." && message.status === "aborted",
          ),
        )
      )
        throw new Error("Exit discarded the partial response");
      if (
        !sessions.some((session) =>
          session.chat?.some((message) => message.tool?.state === "interrupted"),
        )
      )
        throw new Error("Exit did not interrupt the pending tool card");
    } finally {
      store.close();
    }
    if (requests !== 2 || !(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
      throw new Error("Exit executed the pending edit or made extra model requests");
    return {
      requests,
      idleExit: true,
      streamingQuit: true,
      approvalExit: true,
      partialPersisted: true,
      terminalRestored: true,
    };
  } finally {
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
