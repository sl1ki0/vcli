import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

/** Local provider drives the public chat through tool effects, validation stop and restart. */
export async function toolHistorySmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-tool-history-"));
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = requests++;
      const calls =
        turn === 0
          ? [
              { name: "shell_run", arguments: { command: "printf history-success" } },
              { name: "files_read", arguments: { path: "missing-history-file.ts" } },
            ]
          : turn >= 2 && turn <= 4
            ? [
                {
                  name: "architecture_propose",
                  arguments: {
                    design: { version: "1", components: [], decisions: [`Attempt ${turn}`] },
                  },
                },
              ]
            : [];
      const delta = calls.length
        ? {
            tool_calls: calls.map((call, index) => ({
              index,
              id: `history-${turn}-${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : { content: "Checks recorded." };
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 80, completion_tokens: 30 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let terminal: ReturnType<typeof createWorkspaceTerminal> | undefined;
  try {
    await mkdir(join(root, ".vcli"));
    await writeFile(join(root, "app.ts"), "export const ready = true;\n");
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "tool-history-fixture",
        baseURL: server.url.origin,
        permission: "yolo",
      }),
    );
    const options = {
      command,
      cwd: root,
      env: {
        VCLI_CONFIG_HOME: join(root, "configuration"),
        VCLI_COMPATIBLE_API_KEY: "local-fixture-key",
        VCLI_COMPATIBLE_BASE_URL: server.url.origin,
      },
    };
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("Run checks and keep their tool history", "Checks recorded.");
    await terminal.waitFor("Ready");
    await terminal.waitFor("Run command · Succeeded");
    await terminal.waitFor("Read file · Failed");
    await terminal.waitFor("history-success");
    await terminal.submit("Try the architecture request", "Stopped after 3 requests");
    await terminal.waitFor("Blocked");
    await terminal.waitFor("Failed");
    if (requests !== 5)
      throw terminal.failure(`Invalid requests did not stop inference (${requests})`);
    await terminal.quit();
    await terminal.close();
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("/history", "Conversation history");
    await terminal.waitFor("2. Run checks and keep their tool history");
    await terminal.waitFor("Resumed conversation", terminal.write("2"));
    await terminal.waitFor("Blocked");
    await terminal.waitFor("Stopped after 3 requests");
    const top = terminal.write("\t\u001b[H");
    await terminal.waitFor("Run checks and keep their tool history", top);
    await terminal.waitFor("Run command · Succeeded");
    // The first visible entry is the user's prompt, followed by the shell card.
    terminal.write("\u001b[B ");
    await terminal.waitFor("[F] Open full saved result");
    await terminal.waitFor("Full saved result · local view", terminal.write("f"));
    await terminal.waitFor("history-success");
    if (requests !== 5) throw terminal.failure("History or artifact browsing made a model request");
    await terminal.quit();
    return {
      requests,
      persistedToolCards: true,
      fullArtifactLocal: true,
      invalidRequestsStopped: true,
    };
  } finally {
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
