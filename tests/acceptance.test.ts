import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArchitectureService } from "@vcli/architecture";
import { balanced, estimateTokens, type ArchitectureDesign, type RuntimeEvent } from "@vcli/core";
import { createHarness } from "../apps/cli/src/harness.ts";
import { loadConfig } from "../apps/cli/src/config.ts";
import { executeProcess } from "../apps/cli/src/builtin-tools.ts";
import {
  response as mcpResponse,
  type RpcRequest,
} from "../packages/integrations/test/fixture-server.ts";

type Call = { name: string; args: Record<string, unknown> };
type Reply = { text?: string; calls?: Call[] };
type Captured = {
  messages: { role: string; content?: string; tool_call_id?: string }[];
  tools: unknown[];
  [key: string]: unknown;
};
function fixture(reply: (request: Captured, turn: number) => Reply) {
  const requests: Captured[] = [];
  const failures: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      try {
        const body = (await request.json()) as Captured;
        const turn = requests.push(body) - 1;
        const result = reply(body, turn);
        const delta = {
          content: result.text ?? "",
          ...(result.calls?.length
            ? {
                tool_calls: result.calls.map((call, index) => ({
                  index,
                  id: `call_${turn}_${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        };
        const chunks = [
          {
            choices: [
              { index: 0, delta, finish_reason: result.calls?.length ? "tool_calls" : "stop" },
            ],
          },
          { choices: [], usage: { prompt_tokens: 60, completion_tokens: 12 } },
        ];
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      } catch (error) {
        failures.push(error);
        return new Response("Fixture assertion failed", { status: 400 });
      }
    },
  });
  return { server, requests, failures };
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function project() {
  const root = await mkdtemp(join(tmpdir(), "vcli-acceptance-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-project", type: "module" }),
  );
  await writeFile(join(root, "src/index.ts"), "export const answer = 0;\n");
  await writeFile(join(root, "src/domain.ts"), "export const answer = 42;\n");
  await writeFile(
    join(root, "verify.ts"),
    'import { answer } from "./src/index.ts";\nif (answer !== 42) throw new Error("Expected 42");\nconsole.log("verification passed: 42");\n',
  );
  return root;
}
async function settings(root: string, endpoint: string, permission: "yolo" | "read-only" = "yolo") {
  return loadConfig(root, {
    provider: "compatible",
    model: "fixture-model",
    baseURL: endpoint,
    permission,
    renderer: "off",
    contextWindow: 24_000,
    context: {
      ...balanced,
      promptTokens: 16_000,
      outputTokens: 512,
      mapTokens: 1000,
      resultTokens: 256,
      maxTurns: 12,
    },
  });
}

describe("architecture-first harness acceptance", () => {
  test("shows the proposed graph before a subsequent patch in the same model tool batch", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    const model = fixture((_, turn) =>
      turn === 0
        ? {
            calls: [
              {
                name: "architecture_propose",
                args: {
                  design: {
                    version: 1,
                    components: [
                      { id: "app", label: "Application", paths: ["src/**", "verify.ts"] },
                    ],
                    decisions: ["Keep the entry and domain together."],
                  },
                },
              },
              {
                name: "files_patch",
                args: {
                  path: "src/index.ts",
                  oldText: "export const answer = 0;",
                  newText: "export const answer = 42;",
                },
              },
            ],
          }
        : { text: "Design displayed and source updated." },
    );
    const events: RuntimeEvent[] = [];
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness(
        root,
        await settings(root, model.server.url.origin),
        createArchitectureService(),
        (event) => {
          events.push(event);
        },
      );
      expect(
        (await harness.run("Show the design before editing.", new AbortController().signal)).status,
      ).toBe("complete");
      const planned = events.findIndex(
        (event) => event.type === "tool-end" && event.data.name === "architecture_propose",
      );
      const patch = events.findIndex(
        (event) => event.type === "tool-start" && event.data.name === "files_patch",
      );
      expect(planned).toBeGreaterThanOrEqual(0);
      expect(patch).toBeGreaterThan(planned);
      expect(events[planned]?.data.details).toMatchObject({
        intended: { nodes: [{ id: "component:app", status: "planned" }] },
      });
    } finally {
      await harness?.close();
      model.server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scans, proposes a design, patches source, verifies, updates the graph, and resumes the session", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    const design: ArchitectureDesign = {
      version: 1,
      components: [
        { id: "entry", label: "Entry", paths: ["src/index.ts"], dependencies: ["domain"] },
        { id: "domain", label: "Domain", paths: ["src/domain.ts"], dependencies: [] },
        {
          id: "verification",
          label: "Verification",
          paths: ["verify.ts"],
          dependencies: ["entry"],
        },
      ],
      decisions: ["Entry delegates its answer to Domain."],
    };
    const command = `${quote(process.execPath)} run verify.ts`;
    const model = fixture((body, turn) => {
      const results = body.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content ?? "");
      if (turn === 0) return { calls: [{ name: "architecture_query", args: { query: "src" } }] };
      if (turn === 1) {
        expect(results.at(-1)).toContain("src/domain.ts");
        return {
          calls: [
            { name: "architecture_propose", args: { design } },
            {
              name: "task_record",
              args: { decisions: design.decisions, pending: ["Implement entry delegation"] },
            },
          ],
        };
      }
      if (turn === 2) {
        expect(results.some((result) => result.includes("Intended architecture updated"))).toBe(
          true,
        );
        return {
          calls: [
            {
              name: "files_patch",
              args: {
                path: "src/index.ts",
                oldText: "export const answer = 0;",
                newText: 'import { answer } from "./domain.ts";\nexport { answer };',
              },
            },
          ],
        };
      }
      if (turn === 3) {
        expect(results.at(-1)).toContain("Updated src/index.ts");
        return { calls: [{ name: "shell_run", args: { command } }] };
      }
      if (turn === 4) {
        expect(results.at(-1)).toContain("verification passed: 42");
        return { calls: [{ name: "task_record", args: { pending: [] } }] };
      }
      if (turn === 5) return { text: "Entry now delegates to Domain; verification passed." };
      if (turn === 6) {
        expect(
          body.messages.some((message) =>
            message.content?.includes("Recheck the saved architecture"),
          ),
        ).toBe(true);
        return { calls: [{ name: "shell_run", args: { command } }] };
      }
      expect(turn).toBe(7);
      expect(results.at(-1)).toContain("verification passed: 42");
      return { text: "Resumed session; verification still passes." };
    });
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const architecture = createArchitectureService();
      const before = await architecture.scan(root);
      expect(
        before.edges.some(
          (edge) => edge.source === "module:src/index.ts" && edge.kind === "import",
        ),
      ).toBe(false);
      const events: RuntimeEvent[] = [];
      let approvals = 0;
      const config = await settings(root, model.server.url.origin);
      harness = await createHarness(
        root,
        config,
        architecture,
        (event) => {
          events.push(event);
        },
        async () => {
          approvals++;
          return false;
        },
      );
      const session = await harness.run(
        "Make Entry delegate to Domain, show the design, and verify.",
        new AbortController().signal,
      );
      expect(session.status).toBe("complete");
      expect(approvals).toBe(0);
      expect(await readFile(join(root, "src/index.ts"), "utf8")).toContain('from "./domain.ts"');
      expect(await architecture.readDesign(root)).toEqual(design);
      expect(session.ledger.decisions).toContain(design.decisions[0]);
      expect(session.ledger.pending).toEqual([]);
      expect(session.ledger.touchedPaths).toContain("src/index.ts");
      expect(
        session.ledger.verification.some((value) => value.includes("verification passed: 42")),
      ).toBe(true);
      const after = await architecture.scan(root);
      expect(after.revision).not.toBe(before.revision);
      expect(
        after.edges.some(
          (edge) =>
            edge.source === "module:src/index.ts" &&
            edge.target === "module:src/domain.ts" &&
            edge.kind === "import",
        ),
      ).toBe(true);
      expect(architecture.check(after, design)).toEqual([]);
      expect(
        events.some(
          (event) => event.type === "architecture" && event.data.revision === after.revision,
        ),
      ).toBe(true);
      const names = events
        .filter((event) => event.type === "tool-start")
        .map((event) => event.data.name);
      expect(names.indexOf("architecture_propose")).toBeLessThan(names.indexOf("files_patch"));
      const intended = events.find(
        (event) => event.type === "tool-end" && event.data.name === "architecture_propose",
      );
      expect(intended?.data.details).toMatchObject({
        intended: {
          nodes: [
            { id: "component:domain", status: "planned" },
            { id: "component:entry", status: "planned" },
            { id: "component:verification", status: "planned" },
          ],
        },
      });
      await harness.close();
      harness = undefined;
      harness = await createHarness(root, config, architecture);
      const restored = await harness.store.get(session.id);
      expect(restored?.ledger.decisions).toEqual(session.ledger.decisions);
      const resumed = await harness.run(
        "Recheck the saved architecture and verification.",
        new AbortController().signal,
        session.id,
      );
      expect(resumed.id).toBe(session.id);
      expect(resumed.status).toBe("complete");
      expect(resumed.usage.input).toBeGreaterThan(session.usage.input);
      expect(await harness.store.list(root)).toHaveLength(1);
      expect(model.requests).toHaveLength(8);
      expect(model.failures).toEqual([]);
    } finally {
      await harness?.close();
      model.server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("retains a full 100,000-line tool artifact while bounding prompt results and permitting scoped retrieval", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    await writeFile(
      join(root, "verbose.ts"),
      'process.stdout.write(Array.from({ length: 100000 }, (_, i) => `line-${i}`).join("\\n") + "\\n");\n',
    );
    let artifact = "";
    const model = fixture((body, turn) => {
      if (turn === 0)
        return {
          calls: [
            { name: "shell_run", args: { command: `${quote(process.execPath)} run verbose.ts` } },
          ],
        };
      const result =
        body.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
      if (turn === 1) {
        expect(result).toContain("line-0");
        expect(result).toContain("line-99999");
        expect(result).not.toContain("line-50000");
        expect(estimateTokens(result)).toBeLessThan(512);
        expect(estimateTokens(JSON.stringify(body))).toBeLessThan(16_000);
        artifact = result.match(/Full result: ([a-f0-9-]{36})/)?.[1] ?? "";
        expect(artifact).not.toBe("");
        return {
          calls: [{ name: "artifacts_read", args: { id: artifact, start: 50001, end: 50003 } }],
        };
      }
      expect(result).toContain("50002: line-50000");
      return { text: "Full output saved; requested lines retrieved." };
    });
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness(
        root,
        await settings(root, model.server.url.origin),
        createArchitectureService(),
      );
      const session = await harness.run(
        "Run the verbose verification and inspect a middle span.",
        new AbortController().signal,
      );
      expect(session.status).toBe("complete");
      const full = await harness.store.readArtifact(artifact);
      expect(full.startsWith("Exit 0\nline-0\n")).toBe(true);
      expect(full.endsWith("line-99999\n")).toBe(true);
      expect(full.split("\n")).toHaveLength(100_002);
      expect(full).toContain("line-50000\n");
      expect(
        session.messages
          .filter((message) => message.role === "tool")
          .every((message) => estimateTokens(message.text) < 512),
      ).toBe(true);
      expect(model.failures).toEqual([]);
    } finally {
      await harness?.close();
      model.server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("suppresses unchanged overlapping reads and refreshes the whole span after an external file mutation", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    const source = Array.from(
      { length: 200 },
      (_, index) => `// source line ${index + 1}: concrete module evidence for the agent`,
    );
    const path = join(root, "src/read.ts");
    await writeFile(path, source.join("\n") + "\n");
    const reads: RuntimeEvent[] = [];
    const model = fixture((body, turn) => {
      if (turn === 0)
        return {
          calls: [
            { name: "files_read", args: { path: "src/read.ts", start: 1, end: 80 } },
            { name: "files_read", args: { path: "src/../src/read.ts", start: 50, end: 120 } },
          ],
        };
      const results = body.messages.filter((message) => message.role === "tool");
      if (turn === 1) {
        const first = results[0]?.content ?? "",
          overlap = results[1]?.content ?? "";
        expect(first).toContain("50: // source line 50:");
        expect(overlap).not.toContain("50: // source line 50:");
        expect(overlap).toContain("81: // source line 81:");
        expect(overlap).toContain("120: // source line 120:");
        expect(overlap).toContain("Unchanged overlapping lines omitted");
        expect(estimateTokens(overlap)).toBeLessThan(estimateTokens(first));
        return {
          calls: [{ name: "files_read", args: { path: "src/read.ts", start: 50, end: 120 } }],
        };
      }
      const refreshed = results.at(-1)?.content ?? "";
      expect(refreshed).toContain("50: // source line 50:");
      expect(refreshed).toContain("80: // source line 80:");
      expect(refreshed).toContain("120: // source line 120:");
      expect(refreshed).not.toContain("overlapping lines omitted");
      return { text: "Source revision changed; requested span refreshed." };
    });
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const config = await settings(root, model.server.url.origin);
      config.context.resultTokens = 4000;
      harness = await createHarness(root, config, createArchitectureService(), async (event) => {
        if (event.type !== "tool-end" || event.data.name !== "files_read") return;
        reads.push(event);
        if (reads.length === 2) {
          // An external editor changes a line outside the requested overlap.
          source[199] = "// externally changed line 200";
          await writeFile(path, source.join("\n") + "\n");
        }
      });
      const session = await harness.run(
        "Inspect overlapping source spans and refresh after an external edit.",
        new AbortController().signal,
      );
      expect(session.status).toBe("complete");
      expect(reads).toHaveLength(3);
      const before = reads[1]!.data.details as { revision: string; sourcePath: string };
      const after = reads[2]!.data.details as { revision: string; sourcePath: string };
      expect(after.sourcePath).toBe(before.sourcePath);
      expect(after.revision).not.toBe(before.revision);
      // Full requested artifacts remain identical because only an unrequested line changed.
      expect(await harness.store.readArtifact(String(reads[2]!.data.artifact))).toBe(
        await harness.store.readArtifact(String(reads[1]!.data.artifact)),
      );
      expect(model.failures).toEqual([]);
    } finally {
      await harness?.close();
      model.server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read-only mode prevents a model-requested patch without changing the source", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    const model = fixture((body, turn) =>
      turn === 0
        ? {
            calls: [
              {
                name: "files_patch",
                args: {
                  path: "src/index.ts",
                  overwrite: true,
                  newText: "export const answer = 42;\n",
                },
              },
            ],
          }
        : { text: body.messages.find((message) => message.role === "tool")?.content ?? "" },
    );
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness(
        root,
        await settings(root, model.server.url.origin, "read-only"),
        createArchitectureService(),
      );
      const session = await harness.run("Inspect without editing.", new AbortController().signal);
      expect(
        session.messages.some((message) =>
          message.text.includes("Read-only mode denies files_patch"),
        ),
      ).toBe(true);
      expect(await readFile(join(root, "src/index.ts"), "utf8")).toBe("export const answer = 0;\n");
      expect(session.ledger.touchedPaths).toEqual([]);
    } finally {
      await harness?.close();
      model.server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects overlapping source matches rather than choosing an ambiguous patch span", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(join(root, "src/index.ts"), "aaa");
      harness = await createHarness(
        root,
        await settings(root, "http://unused.invalid"),
        createArchitectureService(),
      );
      await expect(
        harness.registry.execute(
          {
            id: "ambiguous",
            name: "files_patch",
            arguments: { path: "src/index.ts", oldText: "aa", newText: "b" },
          },
          { root, sessionId: "fixture", signal: new AbortController().signal },
        ),
      ).rejects.toThrow("match exactly once");
      expect(await readFile(join(root, "src/index.ts"), "utf8")).toBe("aaa");
    } finally {
      await harness?.close();
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP discovery cancellation acceptance", () => {
  test("aborts pending tools_search promptly and permits an explicit discovery retry", async () => {
    const root = await project();
    const previousHome = process.env.VCLI_CONFIG_HOME;
    process.env.VCLI_CONFIG_HOME = join(root, ".vcli", "isolated-home");
    let started!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const rpc = (await request.json()) as RpcRequest;
        requests++;
        if (requests === 1) {
          // Keep actual SDK connection startup pending until cancellation.
          started();
          await heldResponse;
        }
        const result = mcpResponse(rpc);
        return result ? Response.json(result) : new Response(null, { status: 202 });
      },
    });
    const controller = new AbortController();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const config = await settings(root, "http://unused.invalid");
      config.mcpServers = [{ name: "fixture", type: "http", url: server.url.href }];
      harness = await createHarness(root, config, createArchitectureService());
      const search = (signal: AbortSignal) =>
        harness!.registry.execute(
          { id: "discover", name: "tools_search", arguments: { query: "Echo input" } },
          { root, sessionId: "fixture", signal },
        );
      pending = search(controller.signal);
      await Promise.race([
        discoveryStarted,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("MCP discovery did not start")), 2000);
        }),
      ]);
      clearTimeout(watchdog);
      const cancelledAt = performance.now();
      controller.abort(new Error("Cancel tools_search discovery"));
      await expect(
        Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("MCP discovery ignored cancellation")),
              1000,
            );
          }),
        ]),
      ).rejects.toThrow("Cancel tools_search discovery");
      clearTimeout(watchdog);
      expect(performance.now() - cancelledAt).toBeLessThan(900);
      expect(
        harness.registry.search("Echo input").some((tool) => tool.name.startsWith("mcp_")),
      ).toBe(false);

      const retried = await search(new AbortController().signal);
      expect(JSON.parse(retried.text).tools).toContainEqual(
        expect.objectContaining({
          description: "fixture: Echo input",
        }),
      );
      const completedRequests = requests;
      await search(new AbortController().signal);
      expect(requests).toBe(completedRequests);
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      release();
      await harness?.close();
      await pending?.catch(() => undefined);
      server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
});

describe("shell cancellation acceptance", () => {
  test("timeout kills a process that ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "vcli-process-"));
    const pidFile = join(root, "pid.txt");
    await writeFile(
      join(root, "stubborn.ts"),
      'import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync("pid.txt", String(process.pid));\nsetInterval(() => {}, 1000);\n',
    );
    const started = performance.now();
    const result = executeProcess(
      process.execPath,
      ["run", "stubborn.ts"],
      { root, sessionId: "fixture", signal: new AbortController().signal },
      150,
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(new Error("Shell timeout failed to terminate a SIGTERM-resistant process")),
            2500,
          );
        }),
      ]);
      expect(finished.code).not.toBe(0);
      expect(finished.output).toContain("timed out");
      expect(performance.now() - started).toBeLessThan(2300);
    } finally {
      clearTimeout(watchdog);
      try {
        const pid = Number(await readFile(pidFile, "utf8"));
        process.kill(-pid, "SIGKILL");
      } catch {}
      await result.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);

  test("abort kills a process that ignores SIGTERM and does not report success", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "vcli-process-"));
    await writeFile(
      join(root, "stubborn.ts"),
      'import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync("pid.txt", String(process.pid));\nsetInterval(() => {}, 1000);\n',
    );
    const controller = new AbortController();
    const result = executeProcess(
      process.execPath,
      ["run", "stubborn.ts"],
      { root, sessionId: "fixture", signal: controller.signal },
      10_000,
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = performance.now() + 1200;
      while (performance.now() < deadline) {
        try {
          await readFile(join(root, "pid.txt"));
          break;
        } catch {
          await Bun.sleep(10);
        }
      }
      controller.abort(new Error("Acceptance cancellation"));
      await expect(
        Promise.race([
          result,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("Abort failed to terminate a SIGTERM-resistant process")),
              2500,
            );
          }),
        ]),
      ).rejects.toThrow("Acceptance cancellation");
    } finally {
      clearTimeout(watchdog);
      try {
        process.kill(-Number(await readFile(join(root, "pid.txt"), "utf8")), "SIGKILL");
      } catch {}
      await result.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
});
