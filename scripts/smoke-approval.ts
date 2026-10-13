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
      const edit = turn % 2 === 0;
      const before = turn <= 2 ? 1 : turn / 2;
      const after = before + 1;
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
                    oldText: `value = ${before}`,
                    newText: `value = ${after}`,
                  }),
                },
              },
            ],
          }
        : {
            content:
              turn === 1
                ? "Edit declined."
                : turn === 3
                  ? "Edit completed."
                  : turn === 5
                    ? "Remembered edit completed."
                    : turn === 7
                      ? "Repeated edit completed."
                      : turn === 9
                        ? "Restored approval applied."
                        : "New conversation edit declined.",
          };
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
    await terminal.submit("/chat", "Chat");
    for (const allow of [false, true]) {
      await terminal.submit("Change the value", "Permission needed");
      await terminal.waitFor("Before · exact text to replace");
      await terminal.waitFor("After · replacement text");
      const frame = terminal.visible();
      if (
        !frame.includes("value = 1") ||
        !frame.includes("value = 2") ||
        !frame.includes("Allow once") ||
        !frame.includes("› Deny") ||
        frame.includes('"newText":')
      )
        throw terminal.failure("Permission card did not display a readable change and decisions");
      if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
        throw new Error("File changed before permission was granted");
      if (allow) {
        await terminal.waitFor("› Allow once", terminal.write("\u001b[A\u001b[A"));
        if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
          throw new Error("Moving the approval selection executed the tool");
      }
      await terminal.waitFor(allow ? "Edit completed." : "Edit declined.", terminal.write("\r"));
      await terminal.waitFor("Ready");
      if (
        !(await readFile(join(root, "app.ts"), "utf8")).includes(allow ? "value = 2" : "value = 1")
      )
        throw new Error("File state does not match the permission decision");
    }
    if (
      Number(requests) !== 4 ||
      !results[0]?.includes("Approval denied") ||
      !results[1]?.includes("Updated app.ts")
    )
      throw new Error(
        `Permission results did not reach the provider correctly (${requests} requests): ${results.join("; ")}`,
      );
    await terminal.submit("Remember edits for this conversation", "Permission needed");
    await terminal.waitFor(
      "› Always allow this tool for this conversation",
      terminal.write("\u001b[A"),
    );
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 2"))
      throw new Error("Selecting always executed the tool before confirmation");
    await terminal.waitFor("Remembered edit completed.", terminal.write("\r"));
    await terminal.waitFor("Ready");
    await terminal.submit("Repeat the remembered edit", "Repeated edit completed.");
    await terminal.waitFor("Ready");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 4"))
      throw new Error("Remembered approval did not apply the repeated edit");
    await terminal.quit();
    await terminal.close();
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("/history", "Conversation history");
    await terminal.waitFor("2. Change the value");
    await terminal.waitFor("Resumed conversation", terminal.write("2"));
    await terminal.submit(
      "Use the remembered approval after restart",
      "Restored approval applied.",
    );
    await terminal.waitFor("Ready");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 5"))
      throw new Error("Remembered approval did not survive restart");
    await terminal.submit("/new", "New conversation.");
    await terminal.submit("A new conversation must ask again", "Permission needed");
    await terminal.waitFor("New conversation edit declined.", terminal.write("\u001b"));
    await terminal.waitFor("Ready");
    if (
      Number(requests) !== 12 ||
      !(await readFile(join(root, "app.ts"), "utf8")).includes("value = 5")
    )
      throw new Error("Approval escaped its original conversation scope");
    await terminal.quit();
    return {
      requests,
      readableApproval: true,
      deniedEditPreserved: true,
      allowedEditApplied: true,
      rememberedAfterRestart: true,
      newConversationAsks: true,
    };
  } finally {
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
