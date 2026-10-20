import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

const PROMPT = "Plan the order correction with verified tasks.";
const plan = {
  goal: "Correct order totals and preserve tests",
  steps: [
    {
      id: "inspect",
      description: "Inspect order behavior",
      dependencies: [],
      tools: ["files_read"],
      verificationTool: "files_read",
      doneWhen: "Inputs understood",
    },
    {
      id: "fix",
      description: "Correct discount calculation",
      dependencies: ["inspect"],
      tools: ["files_patch"],
      verificationTool: "files_patch",
      doneWhen: "Calculation corrected",
    },
    {
      id: "test",
      description: "Run unchanged tests",
      dependencies: ["fix"],
      tools: ["shell_run"],
      verificationTool: "shell_run",
      doneWhen: "Bash exits zero",
    },
  ],
  risks: ["Invalid discount range"],
  assumptions: ["Tests define supported behavior"],
  doneWhen: "Original tests pass",
};

/** Real chat/SQLite/PTY, using the public SDK against a deterministic local provider. */
export async function planSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-plan-smoke-"));
  let requests = 0;
  const failures: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      const system = body.messages.find((message) => message.role === "system")?.content;
      if (typeof system !== "string" || !system.includes("PLAN MODE"))
        failures.push("Plan policy absent from provider request");
      const turn = requests++;
      if (turn > 1) failures.push("Local plan/history commands invoked a model");
      const delta =
        turn === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "publish-plan",
                  type: "function",
                  function: { name: "plan_publish", arguments: JSON.stringify(plan) },
                },
              ],
            }
          : { content: "Plan ready for your decision." };
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: turn === 0 ? "tool_calls" : "stop" }],
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
    await writeFile(join(root, "app.ts"), "export const total = 1;\n");
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "plan-fixture",
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
      },
    };
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "architecture hidden");
    await terminal.submit("/plan", "Plan mode");
    await terminal.submit(PROMPT, "Execution plan");
    await terminal.waitFor("awaiting-plan");
    await terminal.submit("/plan show", "Execution plan");
    await terminal.waitFor("Correct order totals");
    if (terminal.visible().includes("STAGE 1"))
      throw terminal.failure("Plan opened the dependency view before it was requested");
    await terminal.submit("/plan visual", "STAGE 1");
    await terminal.waitFor("STAGE 3");
    await terminal.waitFor("← inspect");
    await terminal.waitFor("← fix");
    await terminal.waitFor("Chat", terminal.write("\u001b"));
    await terminal.quit();
    await terminal.close();

    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "architecture hidden");
    await terminal.submit("/history", "Conversation history");
    await terminal.waitFor(`2. ${PROMPT}`);
    await terminal.waitFor("Resumed conversation", terminal.write("2"));
    await terminal.submit("/plan visual", "STAGE 3");
    await terminal.waitFor("← inspect");
    await terminal.waitFor("Chat", terminal.write("\u001b"));
    await terminal.submit("/plan approve", "Plan approved and saved");
    await terminal.waitFor("BUILD");
    if (requests !== 2 || failures.length)
      throw terminal.failure(`Plan fixture: ${requests} requests; ${failures.join("; ")}`);
    if ((await readFile(join(root, "app.ts"), "utf8")) !== "export const total = 1;\n")
      throw terminal.failure("Planning or approval changed source");
    await terminal.quit();
    return {
      requests,
      chatFirst: true,
      dependencyView: true,
      persistedPlan: true,
      explicitApproval: true,
    };
  } finally {
    await terminal?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
