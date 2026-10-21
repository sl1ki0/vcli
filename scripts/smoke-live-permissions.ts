import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

/** Change policy while the same agent turn is waiting on approval or inference. */
export async function livePermissionsSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-live-permissions-"));
  let requests = 0;
  let releaseModel!: () => void;
  const modelWaiting = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let paused!: () => void;
  const modelPaused = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const results: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const turn = requests++;
      results.push(
        ...body.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content),
      );
      if (turn === 2) {
        paused();
        await modelWaiting;
      }
      const edit = turn < 3 || turn === 4;
      const before = turn < 3 ? turn + 1 : 3;
      const delta = edit
        ? {
            tool_calls: [
              {
                index: 0,
                id: `live-${turn}`,
                type: "function",
                function: {
                  name: "files_patch",
                  arguments: JSON.stringify({
                    path: "app.ts",
                    oldText: `value = ${before}`,
                    newText: `value = ${before + 1}`,
                  }),
                },
              },
              ...(turn === 4
                ? [
                    {
                      index: 1,
                      id: "live-plan",
                      type: "function",
                      function: {
                        name: "plan_publish",
                        arguments: JSON.stringify({
                          goal: "Plan the value change without editing source",
                          steps: [
                            {
                              id: "value",
                              description: "Change and verify the value after approval",
                              dependencies: [],
                              tools: ["files_patch", "files_read"],
                              verificationTool: "files_read",
                              doneWhen: "Source contains the approved value",
                            },
                          ],
                          risks: [],
                          assumptions: ["Plan approval retains the current permission mode"],
                          doneWhen: "The approved change is verified",
                        }),
                      },
                    },
                  ]
                : []),
            ],
          }
        : { content: turn === 3 ? "Live permissions completed." : "Plan policy preserved." };
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
        {
          headers: { "content-type": "text/event-stream" },
        },
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
        model: "live-permissions-fixture",
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
        VCLI_COMPATIBLE_BASE_URL: server.url.origin,
      },
    });
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit("Change the value three times", "Permission needed");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
      throw new Error("Initial ask mode did not gate the edit");
    // Slash input must be reachable from the approval card itself.
    await terminal.waitFor("/", terminal.write("/"));
    await terminal.submit("/permissions yolo", "YOLO");
    await modelPaused;
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 3"))
      throw new Error("Live YOLO did not release pending and subsequent edits");
    // Switch back while inference is still running; menu arrows must work.
    await terminal.waitFor("Permission mode", terminal.write("\u0010"));
    await terminal.waitFor("Permission mode: ASK", terminal.write("\u001b[B\r"));
    releaseModel();
    await terminal.waitFor("Permission needed");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 3"))
      throw new Error("Live ask mode did not gate the next edit");
    // Menus must also be reachable while an approval is pending.
    await terminal.waitFor("Permission mode", terminal.write("\u0010"));
    await terminal.waitFor("Live permissions completed.", terminal.write("\u001b[B\u001b[B\r"));
    await terminal.waitFor("Ready");
    if (!results.at(-1)?.includes("Read-only mode denies"))
      throw new Error("Live read-only did not deny the pending edit");
    const saved = JSON.parse(await readFile(join(root, ".vcli/config.json"), "utf8"));
    if (saved.permission !== "read-only") throw new Error("Live permission mode was not persisted");
    await terminal.submit("/plan", "Plan mode");
    await terminal.submit("/permission yolo", "YOLO");
    await terminal.submit("Attempt an edit in plan mode", "Plan policy preserved.");
    await terminal.waitFor("Ready");
    if (
      !results.some((result) => result.includes("Plan mode denies")) ||
      !(await readFile(join(root, "app.ts"), "utf8")).includes("value = 3")
    )
      throw new Error("Live YOLO bypassed plan/read-only policy");
    await terminal.quit();
    return {
      requests,
      pendingYoloReleased: true,
      liveAskGates: true,
      liveReadOnlyDenies: true,
      planPreserved: true,
    };
  } finally {
    releaseModel();
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
