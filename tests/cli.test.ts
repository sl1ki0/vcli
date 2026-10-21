import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent } from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { terminalSmoke } from "../scripts/smoke-terminal.ts";

const cli = resolve(import.meta.dir, "../apps/cli/src/index.ts");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "vcli cli fixture-"));
  const root = join(directory, "project"),
    home = join(directory, "config");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(home);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cli-fixture", type: "module" }),
  );
  await writeFile(join(root, "src/index.ts"), "export const value = 1;\n");
  return { directory, root, home };
}
function environment(home: string) {
  return {
    ...process.env,
    VCLI_CONFIG_HOME: home,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    VCLI_COMPATIBLE_API_KEY: "",
  };
}
async function run(root: string, home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args, "--root", root], {
    cwd: root,
    env: environment(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
const rows = (text: string): RuntimeEvent[] =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);

describe("CLI configuration and non-TTY operation", () => {
  test("source client opens and restores an interactive terminal from another project directory", async () => {
    const w = await workspace();
    try {
      await terminalSmoke([process.execPath, cli], w.root, "off");
    } finally {
      await rm(w.directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("defaults to YOLO and inspects architecture without credentials or terminal escapes", async () => {
    const w = await workspace();
    try {
      const configuration = await run(w.root, w.home, ["config", "show"]);
      expect(configuration.code).toBe(0);
      expect(JSON.parse(configuration.stdout).permission).toBe("yolo");
      for (const args of [[], ["architecture", "view"], ["architecture", "scan"]]) {
        const result = await run(w.root, w.home, args);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("src/index.ts");
        expect(result.stdout + result.stderr).not.toContain("\u001b");
        expect(result.stdout + result.stderr).not.toContain("API key");
      }
      const json = await run(w.root, w.home, ["architecture", "scan", "--json"]);
      expect(json.code).toBe(0);
      const graph = JSON.parse(json.stdout);
      expect(graph.nodes.some((node: { id: string }) => node.id === "module:src/index.ts")).toBe(
        true,
      );
      const help = await run(w.root, w.home, ["--help"]);
      expect(help.stdout).toContain("YOLO is the default");
      expect(help.stdout).not.toContain("\u001b");
    } finally {
      await rm(w.directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("merges configuration budgets and keeps user permission above project policy", async () => {
    const w = await workspace();
    try {
      await writeFile(
        join(w.home, "config.json"),
        JSON.stringify({
          provider: "anthropic",
          model: "user-model",
          permission: "ask",
          renderer: "blocks",
          context: { mapTokens: 777, resultTokens: 888 },
        }),
      );
      await mkdir(join(w.root, ".vcli"));
      await writeFile(
        join(w.root, ".vcli/config.json"),
        JSON.stringify({
          provider: "compatible",
          model: "project-model",
          permission: "yolo",
          context: { resultTokens: 333, outputTokens: 1024 },
          baseURL: "http://project.invalid",
        }),
      );
      const inherited = await run(w.root, w.home, ["config", "show"]);
      const project = JSON.parse(inherited.stdout);
      expect(project).toMatchObject({
        provider: "compatible",
        model: "project-model",
        permission: "ask",
        renderer: "blocks",
        context: { mapTokens: 777, resultTokens: 333, outputTokens: 1024, schemaTokens: 4000 },
      });
      const weakened = await run(w.root, w.home, [
        "config",
        "set",
        "permission",
        "yolo",
        "--project",
      ]);
      expect(weakened.code).toBe(1);
      expect(weakened.stderr).toContain("cannot weaken the user permission ask");
      const explicit = await run(w.root, w.home, ["config", "show", "--permission", "yolo"]);
      expect(explicit.code).toBe(0);
      expect(JSON.parse(explicit.stdout).permission).toBe("yolo");
      const overridden = await run(w.root, w.home, [
        "config",
        "show",
        "--provider",
        "openai",
        "--model",
        "flag-model",
        "--permission",
        "read-only",
        "--renderer",
        "off",
        "--endpoint",
        "http://flag.invalid",
      ]);
      expect(overridden.code).toBe(0);
      expect(JSON.parse(overridden.stdout)).toMatchObject({
        provider: "openai",
        model: "flag-model",
        permission: "read-only",
        renderer: "off",
        baseURL: "http://flag.invalid",
        context: { mapTokens: 777, resultTokens: 333 },
      });
      expect(
        (await run(w.root, w.home, ["config", "set", "context.resultTokens", "555", "--project"]))
          .code,
      ).toBe(0);
      expect(
        JSON.parse(await readFile(join(w.root, ".vcli/config.json"), "utf8")).context.resultTokens,
      ).toBe(555);
      expect(
        JSON.parse(await readFile(join(w.home, "config.json"), "utf8")).context.resultTokens,
      ).toBe(888);
      const denied = await run(w.root, w.home, [
        "config",
        "set",
        "apiKey",
        "do-not-store",
        "--project",
      ]);
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain(
        "Use vcli setup or environment variables for API credentials",
      );
      expect(await readFile(join(w.root, ".vcli/config.json"), "utf8")).not.toContain(
        "do-not-store",
      );
    } finally {
      await rm(w.directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("redacts MCP environment and header values in config output", async () => {
    const w = await workspace();
    try {
      await writeFile(
        join(w.home, "config.json"),
        JSON.stringify({
          mcpServers: [
            {
              name: "stdio",
              type: "stdio",
              command: "echo",
              env: { API_TOKEN: "private-environment-value" },
            },
            {
              name: "remote",
              type: "http",
              url: "https://example.invalid/mcp",
              headers: { Authorization: "private-header-value" },
            },
          ],
        }),
      );
      const result = await run(w.root, w.home, ["config", "show"]);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("private-environment-value");
      expect(result.stdout).not.toContain("private-header-value");
      expect(result.stdout).toContain("stdio");
    } finally {
      await rm(w.directory, { recursive: true, force: true });
    }
  });
});

describe("real CLI agent sessions", () => {
  test("runs architecture planning, edit, shell verification and resume through the compatible SDK", async () => {
    const w = await workspace();
    const requests: Record<string, unknown>[] = [];
    const failures: unknown[] = [];
    const verify = `${quote(process.execPath)} -e ${quote('import { value } from "./src/index.ts"; if(value !== 2) throw new Error("Bad value"); console.log("CLI verification passed");')}`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const turn = requests.push(body) - 1;
          const calls =
            turn === 0
              ? [
                  {
                    name: "architecture_propose",
                    args: {
                      design: {
                        version: 1,
                        components: [
                          {
                            id: "app",
                            label: "Application",
                            paths: ["src/index.ts"],
                            dependencies: [],
                          },
                        ],
                        decisions: ["Keep the public value in the application module."],
                      },
                    },
                  },
                ]
              : turn === 1
                ? [
                    {
                      name: "files_patch",
                      args: {
                        path: "src/index.ts",
                        oldText: "export const value = 1;",
                        newText: "export const value = 2;",
                      },
                    },
                  ]
                : turn === 2 || turn === 4
                  ? [{ name: "shell_run", args: { command: verify } }]
                  : [];
          if (turn === 3 || turn === 5)
            expect(JSON.stringify(body.messages)).toContain("CLI verification passed");
          if (turn === 4)
            expect(JSON.stringify(body.messages)).toContain("Verify the saved result again");
          const delta = {
            content: calls.length ? "" : "CLI verification passed.",
            ...(calls.length
              ? {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: `cli_${turn}_${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                }
              : {}),
          };
          const chunks = [
            { choices: [{ index: 0, delta, finish_reason: calls.length ? "tool_calls" : "stop" }] },
            { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
          ];
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        } catch (error) {
          failures.push(error);
          return new Response("Fixture failed", { status: 400 });
        }
      },
    });
    try {
      const flags = [
        "--json",
        "--provider",
        "compatible",
        "--model",
        "fixture-model",
        "--endpoint",
        server.url.origin,
      ];
      const initial = await run(w.root, w.home, [
        "run",
        "Plan the architecture, change the value to two, and verify.",
        ...flags,
      ]);
      expect(initial.code).toBe(0);
      expect(initial.stdout + initial.stderr).not.toContain("\u001b");
      const events = rows(initial.stdout);
      const id = String(events.find((event) => event.type === "session")?.data.id);
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect(events.at(-1)?.data.status).toBe("complete");
      expect(
        events.filter((event) => event.type === "tool-start").map((event) => event.data.name),
      ).toEqual(["architecture_propose", "files_patch", "shell_run"]);
      expect(events.filter((event) => event.type === "architecture").length).toBeGreaterThanOrEqual(
        3,
      );
      expect(await readFile(join(w.root, "src/index.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      const resumed = await run(w.root, w.home, [
        "sessions",
        "resume",
        id,
        "Verify the saved result again.",
        ...flags,
      ]);
      expect(resumed.code).toBe(0);
      const resumedEvents = rows(resumed.stdout);
      expect(resumedEvents.find((event) => event.type === "session")?.data.id).toBe(id);
      expect(resumedEvents.at(-1)?.data.status).toBe("complete");
      const listing = await run(w.root, w.home, ["sessions", "list"]);
      const sessions = JSON.parse(listing.stdout);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id,
        status: "complete",
        usage: { input: 300, output: 60 },
      });
      expect(requests).toHaveLength(6);
      expect(failures).toEqual([]);
    } finally {
      server.stop(true);
      await rm(w.directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("SIGINT cancels a real active SDK stream, persists aborted status, and exits 130", async () => {
    const w = await workspace();
    let notify: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        notify();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Working" } }] })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "run",
        "Wait while checking architecture.",
        "--json",
        "--provider",
        "compatible",
        "--model",
        "fixture-model",
        "--endpoint",
        server.url.origin,
        "--root",
        w.root,
      ],
      { cwd: w.root, env: environment(w.home), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("CLI never reached the fixture provider")),
            5000,
          );
        }),
      ]);
      clearTimeout(watchdog);
      child.kill("SIGINT");
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("CLI ignored SIGINT during model streaming")),
            3000,
          );
        }),
      ]);
      expect(code).toBe(130);
      expect(rows(await stdout).at(-1)?.data.status).toBe("aborted");
      expect(await stderr).not.toContain("\u001b");
      const store = await SqliteSessionStore.open(w.root);
      try {
        expect((await store.list(w.root))[0]?.status).toBe("aborted");
      } finally {
        store.close();
      }
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      server.stop(true);
      await rm(w.directory, { recursive: true, force: true });
    }
  }, 10_000);
});
