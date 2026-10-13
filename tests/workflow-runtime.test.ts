import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ModelEvent,
  type ModelRequest,
  type PermissionMode,
  type ProviderAdapter,
  type RuntimeEvent,
  type ToolDefinition,
} from "@vcli/core";
import { createArchitectureService } from "@vcli/architecture";
import { registerBuiltins } from "../apps/cli/src/builtin-tools.ts";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { createLocalWorkflows } from "../apps/cli/src/workflows/runtime.ts";
import { CheckpointService } from "../apps/cli/src/workflows/checkpoints.ts";

const resources: { root: string; store: SqliteSessionStore }[] = [];
afterEach(async () => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
const signal = () => new AbortController().signal;
const call = (name: string, args: Record<string, unknown>, id = name): ModelEvent => ({
  type: "tool-call",
  call: { id, name, arguments: args },
});
const answer = (): ModelEvent[] => [{ type: "text", text: "Finished." }];

type Turn = (request: ModelRequest, turn: number) => ModelEvent[];
async function fixture(
  turn: Turn,
  options: {
    mode?: "build" | "plan";
    permission?: PermissionMode;
    files?: Record<string, string>;
    mcp?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vcli-workflow-runtime-"));
  const store = await SqliteSessionStore.open(root);
  resources.push({ root, store });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(root, path), content);
  }
  const requests: ModelRequest[] = [];
  const events: RuntimeEvent[] = [];
  const provider: ProviderAdapter = {
    id: "fixture",
    model: "fixture",
    contextWindow: 32_768,
    async *stream(request) {
      const index = requests.length;
      requests.push(structuredClone(request));
      for (const event of turn(request, index)) yield event;
      yield { type: "usage", usage: { input: 100, output: 20, cached: 0 } };
      yield { type: "done" };
    },
  };
  const registry = new ToolRegistry();
  const architecture = createArchitectureService();
  const permissions = new PermissionGate(
    options.mode === "plan" ? "read-only" : (options.permission ?? "yolo"),
  );
  let runtime: AgentRuntime;
  let mcpStarted = false;
  const mcpConnect: ToolDefinition = {
    name: "mcp_connect",
    description: "Start MCP",
    inputSchema: {},
    kind: "execute",
    execute: async () => ({ text: "connected" }),
  };
  registerBuiltins(registry, {
    architecture,
    store,
    record: (values) => runtime.record(values),
    discover: async () => {
      if (!options.mcp) return;
      await permissions.authorize(mcpConnect, {});
      mcpStarted = true;
    },
  });
  const workflows = await createLocalWorkflows({
    root,
    registry,
    provider,
    architecture,
    store,
    permissions,
    runtime: () => runtime,
  });
  runtime = new AgentRuntime({
    root,
    provider,
    tools: registry,
    architecture,
    store,
    permissions,
    mode: options.mode,
    instructions: workflows.instructions,
    executeTool: workflows.executeTool,
    settings: { maxTurns: 6 },
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { root, store, runtime, registry, requests, events, mcpStarted: () => mcpStarted };
}

describe("local workflow runtime integration", () => {
  test("loads project instructions into inference and discovers memory without eager schema cost", async () => {
    const f = await fixture(
      (request, turn) => {
        expect(request.system).toContain("Keep the runtime independent of terminal code.");
        if (turn === 0) {
          expect(request.tools.some((tool) => tool.name === "memory_read")).toBe(false);
          return [call("tools_search", { query: "memory" })];
        }
        if (turn === 1) {
          expect(request.tools.some((tool) => tool.name === "memory_read")).toBe(true);
          expect(request.tools.some((tool) => tool.name === "memory_write")).toBe(true);
          return [call("memory_read", {})];
        }
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.text.includes("Revision:"),
          ),
        ).toBe(true);
        return answer();
      },
      {
        files: {
          "AGENTS.md": "Keep the runtime independent of terminal code.",
          ".vcli/MEMORY.md": "Architecture decision: use a portable core.",
        },
      },
    );
    const session = await f.runtime.run("Inspect project memory.", signal());
    expect(session.status).toBe("complete");
    expect((await f.store.get(session.id))?.instructions).toContain("Architecture decision");
  });

  test("plan denies edits, shell execution and command hooks while using no approvals", async () => {
    const f = await fixture(
      (_request, turn) =>
        turn === 0
          ? [
              call("files_patch", { path: "source.ts", oldText: "original", newText: "changed" }),
              call("shell_run", { command: "touch shell-ran" }),
              call("memory_write", { text: "new", expectedRevision: null }),
              call("files_read", { path: "source.ts" }),
            ]
          : answer(),
      {
        mode: "plan",
        files: {
          "source.ts": "original",
          ".vcli/hooks.json": JSON.stringify({
            version: 1,
            beforeTool: [
              { name: "write-from-read", tools: ["files_read"], command: "touch hook-ran" },
            ],
          }),
        },
      },
    );
    const session = await f.runtime.run("Inspect only.", signal());
    const outputs = session.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.text)
      .join("\n");
    expect(outputs).toContain("Plan mode denies files_patch");
    expect(outputs).toContain("Plan mode denies shell_run");
    expect(outputs).toContain("Plan mode denies memory_write");
    expect(outputs).toContain("Read-only mode denies hook.beforeTool.write-from-read");
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toBe("original");
    for (const path of ["shell-ran", "hook-ran", ".vcli/MEMORY.md"])
      await expect(readFile(join(f.root, path))).rejects.toThrow();
    expect(await new CheckpointService(f.root).list()).toEqual([]);
    expect(session.ledger.touchedPaths).toEqual([]);
  });

  test("plan prevents MCP startup through a read-only discovery tool", async () => {
    const f = await fixture(
      (_request, turn) => (turn === 0 ? [call("tools_search", { query: "remote" })] : answer()),
      { mode: "plan", mcp: true },
    );
    await f.runtime.run("Inspect remote tools.", signal());
    expect(f.mcpStarted()).toBe(false);
  });

  test("failed after hooks leave edits successful, checkpoints ready and resumed sessions free of replay", async () => {
    let patchRequests = 0;
    const f = await fixture(
      (_request, turn) => {
        if (turn !== 0) return answer();
        patchRequests++;
        return [
          call("files_patch", { path: "source.ts", oldText: "original", newText: "changed" }),
        ];
      },
      {
        files: {
          "source.ts": "original",
          ".vcli/hooks.json": JSON.stringify({
            version: 1,
            afterTool: [
              {
                name: "failed-notification",
                tools: ["files_patch"],
                command: "printf notification-failed; exit 1",
              },
            ],
          }),
        },
      },
    );
    const session = await f.runtime.run("Change the source.", signal());
    expect(session.status).toBe("complete");
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toBe("changed");
    const end = f.events.find(
      (event) => event.type === "tool-end" && event.data.name === "files_patch",
    )!;
    expect(end.data.isError).toBe(false);
    expect(end.data.result).toContain("Tool outcome is unchanged");
    expect(end.data.result).toContain("notification-failed");
    expect(await f.store.pendingMutations(session.id)).toEqual([]);
    const checkpoints = await new CheckpointService(f.root).list(session.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.status).toBe("ready");
    const resumed = await f.runtime.run(
      "Continue after notification failure.",
      signal(),
      session.id,
    );
    expect(resumed.status).toBe("complete");
    expect(patchRequests).toBe(1);
    expect(
      f.events.filter((event) => event.type === "tool-start" && event.data.name === "files_patch"),
    ).toHaveLength(1);
    expect(resumed.ledger.constraints.some((constraint) => constraint.includes("uncertain"))).toBe(
      false,
    );
  });
});
