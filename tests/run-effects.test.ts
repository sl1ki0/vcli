import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import { balanced, type PermissionMode, type RuntimeEvent, type ToolCall } from "@vcli/core";
import type { Config } from "../apps/cli/src/config.ts";
import { createHarness } from "../apps/cli/src/harness.ts";
import { decideTool, journalForRun, withRun } from "../apps/cli/src/workflows/run-controls.ts";

const HOOK_COMMAND = "printf hook-executed >> marker.txt";
const READ: ToolCall = { id: "read-source", name: "files_read", arguments: { path: "app.ts" } };

/** Deterministic model decisions still execute the production SDK, permissions and shell hooks. */
async function effectFixture(
  call: ToolCall,
  sideEffects: number,
  permission: PermissionMode = "yolo",
  hook = true,
  afterCall?: ToolCall,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-effects-")));
  const root = join(directory, "workspace");
  await mkdir(join(root, ".vcli"), { recursive: true });
  await writeFile(join(root, "app.ts"), "export const ready = true;\n");
  if (hook)
    await writeFile(
      join(root, ".vcli/hooks.json"),
      JSON.stringify({
        version: 1,
        beforeTool: [{ name: "marker", tools: ["files_read"], command: HOOK_COMMAND }],
      }),
    );
  const previousHome = process.env.VCLI_CONFIG_HOME;
  process.env.VCLI_CONFIG_HOME = join(directory, "configuration");
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = requests++;
      const invoked = turn === 0 ? call : turn === 1 ? afterCall : undefined;
      const delta = invoked
        ? {
            tool_calls: [
              {
                index: 0,
                id: invoked.id,
                type: "function",
                function: { name: invoked.name, arguments: JSON.stringify(invoked.arguments) },
              },
            ],
          }
        : { content: "The recorded action finished." };
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: invoked ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const config: Config = {
    provider: "compatible",
    model: "effects-fixture",
    baseURL: server.url.origin + "/v1",
    permission,
    renderer: "off",
    context: { ...balanced, outputTokens: 1000 },
    mcpServers: [],
    runLimits: { sideEffects },
  };
  const options = { stateDirectory: join(directory, "state"), apiKey: "local-fixture-key" };
  return {
    root,
    config,
    options,
    requests: () => requests,
    markerExists: () => Bun.file(join(root, "marker.txt")).exists(),
    async close() {
      server.stop(true);
      if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
      else process.env.VCLI_CONFIG_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a zero effect budget blocks a read's command hook before any executor starts", async () => {
  const fixture = await effectFixture(READ, 0);
  const events: RuntimeEvent[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(
      fixture.root,
      fixture.config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      undefined,
      fixture.options,
    );
    const session = await harness.run("Read app.ts", new AbortController().signal);
    expect(session.status).toBe("budget");
    expect(session.runState?.counters).toMatchObject({
      modelRequests: 1,
      toolCalls: 0,
      sideEffects: 0,
    });
    expect(Object.keys(session.runState!.calls)).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    expect(await fixture.markerExists()).toBe(false);
    expect(fixture.requests()).toBe(1);
    expect((await harness.store.get(session.id))?.status).toBe("budget");
  } finally {
    await harness?.close();
    await fixture.close();
  }
});

test("ask mode durably approves a read plus its exact hook contract and resumes it once", async () => {
  const fixture = await effectFixture(READ, 1, "ask");
  const events: RuntimeEvent[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(
      fixture.root,
      fixture.config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      undefined,
      fixture.options,
    );
    const paused = await harness.run(
      "Read app.ts and run its configured hook",
      new AbortController().signal,
    );
    expect(paused.status).toBe("awaiting-approval");
    expect(await fixture.markerExists()).toBe(false);
    expect(fixture.requests()).toBe(1);
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    const entry = paused.runState!.calls[READ.id]!;
    expect(entry).toMatchObject({ status: "approval", sideEffects: 1, attempts: 0, call: READ });

    // The saved approval fingerprints both the read schema and the complete command effect summary.
    const tool = harness.registry.get("files_read")!;
    const contract = JSON.stringify({
      name: tool.name,
      kind: "execute",
      description: `${tool.description}\nExecution effects: beforeTool hook marker: ${HOOK_COMMAND}`,
      inputSchema: tool.inputSchema,
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contract)),
    );
    expect(entry.approval?.schemaDigest).toBe(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    await harness.close();
    harness = undefined;
    await decideTool(fixture.root, paused.id, READ.id, true, fixture.options);
    expect(fixture.requests()).toBe(1);
    expect(await fixture.markerExists()).toBe(false);

    // A shell-only permission override may be absent on resume, restoring default YOLO.
    // The recorded decision must still be checked against the saved compound contract.
    fixture.config.permission = "yolo";
    harness = await createHarness(
      fixture.root,
      fixture.config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      async () => {
        throw new Error("Persisted composite approval must not ask again");
      },
      { ...fixture.options, resumeId: paused.id },
    );
    const resumed = await harness.run("", new AbortController().signal, paused.id);
    expect(resumed.status).toBe("complete");
    expect(await readFile(join(fixture.root, "marker.txt"), "utf8")).toBe("hook-executed");
    expect(resumed.runState?.counters).toMatchObject({
      modelRequests: 2,
      toolCalls: 1,
      sideEffects: 1,
    });
    expect(resumed.runState?.calls[READ.id]).toMatchObject({
      status: "complete",
      attempts: 1,
      approval: { decision: true },
      call: READ,
    });
    expect(
      events.filter((event) => event.type === "tool-start" && event.data.callId === READ.id),
    ).toHaveLength(1);
    expect(fixture.requests()).toBe(2);
    await harness.close();
    harness = undefined;
    await withRun(fixture.root, paused.id, fixture.options, async (saved) => {
      const journal = await journalForRun(fixture.root, saved, fixture.options);
      const changes = await journal.inspect(saved.id);
      expect(changes.paths).toContain("marker.txt");
      expect(changes.diff).toContain("+hook-executed");
      expect(changes.pending).toBeUndefined();
    });
  } finally {
    await harness?.close();
    await fixture.close();
  }
});

test("a zero effect budget blocks deferred MCP startup before the endpoint is contacted", async () => {
  const search: ToolCall = {
    id: "discover-external",
    name: "tools_search",
    arguments: { query: "external tool" },
  };
  const fixture = await effectFixture(search, 0, "yolo", false);
  let endpointRequests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      endpointRequests++;
      return new Response("Unexpected MCP connection", { status: 500 });
    },
  });
  fixture.config.mcpServers = [{ name: "external-fixture", type: "http", url: endpoint.url.href }];
  const events: RuntimeEvent[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(
      fixture.root,
      fixture.config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      undefined,
      fixture.options,
    );
    const session = await harness.run("Discover external tools", new AbortController().signal);
    expect(session.status).toBe("budget");
    expect(session.runState?.counters).toMatchObject({
      modelRequests: 1,
      toolCalls: 0,
      sideEffects: 0,
    });
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    expect(endpointRequests).toBe(0);
    expect(fixture.requests()).toBe(1);
  } finally {
    await harness?.close();
    endpoint.stop(true);
    await fixture.close();
  }
});

test("Plan Mode discovers local schemas with MCP configured and no side-effect allowance", async () => {
  const search: ToolCall = {
    id: "local-search",
    name: "tools_search",
    arguments: { query: "plan task" },
  };
  const publish: ToolCall = {
    id: "local-plan",
    name: "plan_publish",
    arguments: {
      goal: "Inspect the source",
      risks: [],
      assumptions: [],
      doneWhen: "Source inspected",
      steps: [
        {
          id: "inspect",
          description: "Read app.ts",
          dependencies: [],
          tools: ["files_read"],
          verificationTool: "files_read",
          doneWhen: "Source read successfully",
        },
      ],
    },
  };
  const fixture = await effectFixture(search, 0, "yolo", false, publish);
  let endpointRequests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      endpointRequests++;
      return new Response("Unexpected startup", { status: 500 });
    },
  });
  fixture.config.mcpServers = [{ name: "external-fixture", type: "http", url: endpoint.url.href }];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(
      fixture.root,
      fixture.config,
      createArchitectureService(),
      undefined,
      undefined,
      { ...fixture.options, mode: "plan" },
    );
    const session = await harness.run("Plan the inspection", new AbortController().signal);
    expect(session.status).toBe("awaiting-plan");
    expect(session.runState?.calls[search.id]?.result?.isError).toBe(false);
    expect(session.runState?.counters.sideEffects).toBe(0);
    expect(session.plan?.status).toBe("draft");
    expect(endpointRequests).toBe(0);
    expect(fixture.requests()).toBe(3);
  } finally {
    await harness?.close();
    endpoint.stop(true);
    await fixture.close();
  }
});
