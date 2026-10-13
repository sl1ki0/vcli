import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

/** Exercise actual permission decisions through the renderer, SDK and file executor. */
export async function approvalSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-approval-"));
  let requests = 0;
  const results: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const turn = requests++;
      const last = body.messages.filter((message) => message.role === "tool").at(-1);
      if (turn === 1 || turn === 3) results.push(last?.content ?? "(missing tool result)");
      const edit = turn === 0 || turn === 2;
      const delta = edit
        ? {
            tool_calls: [
              {
                index: 0,
                id: `patch-${turn}`,
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
          }
        : { content: turn === 1 ? "Edit declined." : "Edit completed." };
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: edit ? "tool_calls" : "stop" }],
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
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "approval-fixture",
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
    for (const allow of [false, true]) {
      await terminal.submit("Change the value", "Permission needed");
      await terminal.waitFor("Before · exact text to replace");
      await terminal.waitFor("After · replacement text");
      const frame = terminal.visible();
      if (
        !frame.includes("value = 1") ||
        !frame.includes("value = 2") ||
        !frame.includes("[Y] Allow once") ||
        !frame.includes("[N / Esc] Deny") ||
        frame.includes('"newText":')
      )
        throw terminal.failure("Permission card did not display a readable change and decisions");
      if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
        throw new Error("File changed before permission was granted");
      await terminal.waitFor(
        allow ? "Edit completed." : "Edit declined.",
        terminal.write(allow ? "y" : "n"),
      );
      await terminal.waitFor("Ready");
      if (
        !(await readFile(join(root, "app.ts"), "utf8")).includes(allow ? "value = 2" : "value = 1")
      )
        throw new Error("File state does not match the permission decision");
    }
    if (
      requests !== 4 ||
      !results[0]?.includes("Approval denied") ||
      !results[1]?.includes("Updated app.ts")
    )
      throw new Error(
        `Permission results did not reach the provider correctly (${requests} requests): ${results.join("; ")}`,
      );
    await terminal.quit();
    return {
      requests,
      readableApproval: true,
      deniedEditPreserved: true,
      allowedEditApplied: true,
    };
  } finally {
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
