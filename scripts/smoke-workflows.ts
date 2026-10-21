import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Exercise public commands and the real provider SDK outside the source checkout. */
export async function workflowsSmoke(command: string | string[]) {
  const root = await mkdtemp(join(tmpdir(), "vcli-workflows-"));
  let requests = 0;
  const failures: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Preserve the public API"))
        failures.push("Project memory missing from prompt");
      const turn = requests++;
      if (turn <= 3 && !system.includes("PLAN MODE")) failures.push("Planning mode lost on resume");
      if (turn > 3 && system.includes("PLAN MODE")) failures.push("Explicit build mode ignored");
      const patch = {
        id: `patch-${turn}`,
        type: "function",
        function: {
          name: "files_patch",
          arguments: JSON.stringify({ path: "app.ts", oldText: "value = 1", newText: "value = 2" }),
        },
      };
      const calls =
        turn === 0
          ? [patch]
          : turn === 1
            ? [
                {
                  id: "publish-plan",
                  type: "function",
                  function: {
                    name: "plan_publish",
                    arguments: JSON.stringify({
                      goal: "Implementation plan: change value and verify the public API",
                      steps: [
                        {
                          id: "value",
                          description: "Change and verify the value",
                          dependencies: [],
                          tools: ["files_patch", "files_read", "tasks_update"],
                          verificationTool: "files_read",
                          doneWhen: "Source contains value = 2",
                        },
                      ],
                      risks: [],
                      assumptions: ["The public API remains unchanged"],
                      doneWhen: "The value is updated and verified",
                    }),
                  },
                },
              ]
            : turn === 4
              ? [
                  patch,
                  {
                    id: "task",
                    type: "function",
                    function: {
                      name: "tasks_update",
                      arguments: JSON.stringify({
                        title: "Verify public API",
                        description: "Confirm the value change",
                      }),
                    },
                  },
                  {
                    id: "verify-file",
                    type: "function",
                    function: { name: "files_read", arguments: JSON.stringify({ path: "app.ts" }) },
                  },
                ]
              : turn === 5
                ? [
                    {
                      id: "verify-task",
                      type: "function",
                      function: {
                        name: "plan_task",
                        arguments: JSON.stringify({
                          action: "verify",
                          taskId: "value",
                          evidenceCallIds: ["patch-4", "verify-file"],
                        }),
                      },
                    },
                  ]
                : [];
      const data = [
        {
          choices: [
            {
              index: 0,
              delta: calls.length
                ? { tool_calls: calls.map((call, index) => ({ ...call, index })) }
                : {
                    content:
                      turn <= 3
                        ? "# Implementation plan\n\nChange the value and verify the public API."
                        : "Implementation finished.",
                  },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 40 },
        },
      ];
      return new Response(
        data.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const run = async (...args: string[]) => {
    const process = Bun.spawn([...(typeof command === "string" ? [command] : command), ...args], {
      cwd: root,
      env: {
        ...Bun.env,
        VCLI_CONFIG_HOME: join(root, "configuration"),
        VCLI_COMPATIBLE_API_KEY: "local-fixture-key",
        VCLI_COMPATIBLE_BASE_URL: server.url.origin,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code || stdout.includes("\u001b"))
      throw new Error(`Workflow command failed: ${args.join(" ")}\n${stderr}`);
    return stdout;
  };
  try {
    await mkdir(join(root, ".vcli"));
    await writeFile(
      join(root, ".vcli/config.json"),
      JSON.stringify({
        provider: "compatible",
        model: "workflow-fixture",
        baseURL: server.url.origin,
      }),
    );
    await writeFile(join(root, "AGENTS.md"), "Preserve the public API.");
    await writeFile(join(root, "app.ts"), "export const value = 1;\n");
    const events = (await run("run", "Plan the value change", "--plan", "--json"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const session = events.find((event) => event.type === "session")?.sessionId;
    if (!session || !events.some((event) => event.type === "tool-end" && event.data.isError))
      throw new Error("Planning did not deny the attempted edit");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
      throw new Error("Plan mode changed source");
    if (!(await run("plan", "show")).includes("Implementation plan"))
      throw new Error("Plan was not saved");
    await run("sessions", "resume", session, "Continue planning", "--json");
    await run("sessions", "resume", session, "Implement the plan", "--build", "--json");
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 2"))
      throw new Error("Build mode did not implement the edit");
    if (!(await run("tasks", "list")).includes("Verify public API"))
      throw new Error("Task was not persisted");
    const id = (await run("checkpoints", "list")).match(/[a-f0-9-]{36}/)?.[0];
    if (!id) throw new Error("File edit was not checkpointed");
    await run("checkpoints", "restore", id);
    if (!(await readFile(join(root, "app.ts"), "utf8")).includes("value = 1"))
      throw new Error("Rewind failed");
    for (const topic of ["memory", "hooks"]) await run(topic, "show");
    if (requests !== 7 || failures.length)
      throw new Error(`Workflow fixture: ${requests} requests; ${failures.join("; ")}`);
    return { requests, planProtected: true, resumedPlan: true, tasksPersisted: true, rewind: true };
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
