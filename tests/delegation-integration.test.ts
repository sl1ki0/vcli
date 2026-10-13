import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type ProviderAdapter,
  type RuntimeEvent,
} from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { registerBuiltins } from "../apps/cli/src/builtin-tools.ts";
import { createLocalWorkflows } from "../apps/cli/src/workflows/runtime.ts";

test("local workflow factory isolates explorer capabilities and includes its usage in the parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vcli-child-integration-"));
  const store = await SqliteSessionStore.open(root);
  const graph = {
    root,
    revision: "fixture",
    nodes: [],
    edges: [],
    cycles: [],
    diagnostics: [],
    stats: { files: 0, parsed: 0, cached: 0, durationMs: 0 },
  };
  const architecture: ArchitectureService = {
    scan: async () => graph,
    readDesign: async () => ({ version: 1, components: [], decisions: [] }),
    writeDesign: async () => {},
    intendedGraph: () => graph,
    check: () => [],
  };
  const events: RuntimeEvent[] = [];
  const forbidden = [
    "files_patch",
    "shell_run",
    "subagent_explore",
    "tools_search",
    "mcp_mutation",
  ];
  let parentTurns = 0;
  let childTurns = 0;
  const provider: ProviderAdapter = {
    id: "fixture",
    model: "fixture",
    contextWindow: 32000,
    async *stream(request) {
      const child = request.messages[0]!.text.includes("Delegated task:");
      if (child) {
        childTurns++;
        expect(request.tools.map((tool) => tool.name).sort()).toEqual([
          "architecture_query",
          "artifacts_read",
          "files_list",
          "files_read",
          "files_search",
        ]);
        if (childTurns === 1) {
          yield {
            type: "tool-call",
            call: { id: "source", name: "files_read", arguments: { path: "app.ts" } },
          };
          for (const name of forbidden)
            yield { type: "tool-call", call: { id: name, name, arguments: {} } };
        } else {
          expect(
            request.messages.some(
              (message) =>
                message.role === "tool" && message.text.includes("export const result = 42"),
            ),
          ).toBe(true);
          for (const name of forbidden)
            expect(
              request.messages.some(
                (message) => message.toolName === name && message.text.includes("Unknown tool"),
              ),
            ).toBe(true);
          yield { type: "text", text: "app.ts:1 exports result = 42." };
        }
      } else {
        parentTurns++;
        if (parentTurns === 1)
          yield {
            type: "tool-call",
            call: {
              id: "delegate",
              name: "subagent_explore",
              arguments: { prompt: "Inspect app.ts exports", tokens: 12000 },
            },
          };
        else {
          expect(
            request.messages.some(
              (message) => message.role === "tool" && message.text.includes("result = 42"),
            ),
          ).toBe(true);
          yield { type: "text", text: "Inspection complete." };
        }
      }
      yield { type: "usage", usage: { input: 100, output: 25, cached: 10 } };
      yield { type: "done" };
    },
  };
  try {
    await writeFile(join(root, "app.ts"), "export const result = 42;\n");
    const registry = new ToolRegistry();
    const permissions = new PermissionGate("yolo");
    let runtime: AgentRuntime;
    registerBuiltins(registry, { architecture, store, record: async () => {} });
    registry.register({
      name: "mcp_mutation",
      kind: "write",
      description: "Must not be delegated",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new Error("Unexpected execution");
      },
    });
    await createLocalWorkflows({
      root,
      registry,
      provider,
      architecture,
      store,
      permissions,
      runtime: () => runtime,
      emit: (event) => {
        events.push(event);
      },
    });
    registry.activate(["subagent_explore"]);
    runtime = new AgentRuntime({
      root,
      provider,
      architecture,
      store,
      permissions,
      tools: registry,
      settings: { taskTokens: 50000 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const parent = await runtime.run("Delegate an inspection", new AbortController().signal);
    expect(parent.status).toBe("complete");
    expect(parent.usage).toEqual({ input: 400, output: 100, cached: 40 });
    expect(parent.budgetSpent).toBe(500);
    expect(parentTurns).toBe(2);
    expect(childTurns).toBe(2);
    const children = events.filter((event) => event.type === "subagent");
    expect(children.length).toBeGreaterThan(2);
    expect(children.every((event) => event.sessionId === parent.id)).toBe(true);
    expect(
      children.some(
        (event) => event.data.sessionId !== undefined && event.data.sessionId !== parent.id,
      ),
    ).toBe(true);
    expect(parent.chat?.some((message) => message.text.includes("Delegated task:"))).toBe(false);
    const persisted = await store.get(parent.id);
    expect(persisted!.budgetSpent).toBe(500);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
