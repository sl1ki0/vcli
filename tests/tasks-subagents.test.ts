import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type Session,
  type ProviderAdapter,
} from "@vcli/core";
import { LocalTaskStore } from "../apps/cli/src/workflows/tasks.ts";
import { SubagentService, type SubagentUpdate } from "../apps/cli/src/workflows/subagents.ts";
import { createTaskTools } from "../apps/cli/src/tools/tasks.ts";
import { createSubagentTool } from "../apps/cli/src/tools/subagents.ts";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vcli-delegation-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("persistent local tasks", () => {
  test("survives reload, validates dependency transitions and preserves documents on rejected edits", async () => {
    const { root, cleanup } = await fixture();
    try {
      const store = new LocalTaskStore(root);
      const first = await store.create({ title: "Inspect" }, "parent");
      const second = await store.create({ title: "Implement", dependencies: [first.id] }, "parent");
      await expect(store.update(second.id, { status: "in-progress" })).rejects.toThrow("blocked");
      await expect(store.update(first.id, { dependencies: [second.id] })).rejects.toThrow("cycle");
      await expect(store.update(first.id, { dependencies: ["missing"] })).rejects.toThrow(
        "Unknown",
      );
      await store.update(first.id, { status: "complete" });
      await store.update(second.id, { status: "in-progress" });
      await expect(store.update(first.id, { status: "pending" })).rejects.toThrow("blocked");
      const restored = await new LocalTaskStore(root).list();
      expect(restored.map((task) => task.status)).toEqual(["complete", "in-progress"]);
      expect(restored[1]!.dependencies).toEqual([first.id]);
    } finally {
      await cleanup();
    }
  });

  test("independent store instances serialize updates and reject canceled writes", async () => {
    const { root, cleanup } = await fixture();
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          new LocalTaskStore(root).create({ title: `Task ${i}` }, "parent"),
        ),
      );
      const store = new LocalTaskStore(root);
      expect(await store.list()).toHaveLength(8);
      await expect(
        store.create({ title: "Canceled" }, "parent", AbortSignal.abort()),
      ).rejects.toThrow();
      expect(await store.list()).toHaveLength(8);
      await writeFile(join(root, ".vcli/state/tasks.json"), "{bad");
      await expect(
        store.create({ title: "Do not overwrite corrupt state" }, "parent"),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("task tools use one policy boundary and reject malformed inputs", async () => {
    const { root, cleanup } = await fixture();
    try {
      const registry = new ToolRegistry();
      for (const tool of createTaskTools(new LocalTaskStore(root))) registry.register(tool);
      expect(registry.schemas(4000)).toHaveLength(0);
      await new PermissionGate("read-only").authorize(registry.get("tasks_list")!, {});
      await expect(
        new PermissionGate("read-only").authorize(registry.get("tasks_update")!, {}),
      ).rejects.toThrow("denies");
      await expect(
        registry.execute(
          { id: "invalid", name: "tasks_update", arguments: { title: "x", status: "finished" } },
          { root, sessionId: "parent", signal: new AbortController().signal },
        ),
      ).rejects.toThrow("Invalid arguments");
    } finally {
      await cleanup();
    }
  });
});

function architecture(root: string): ArchitectureService {
  const graph = {
    root,
    revision: "fixture",
    nodes: [],
    edges: [],
    cycles: [],
    diagnostics: [],
    stats: { files: 0, parsed: 0, cached: 0, durationMs: 0 },
  };
  return {
    scan: async () => graph,
    readDesign: async () => ({ version: 1, components: [], decisions: [] }),
    writeDesign: async () => {},
    intendedGraph: () => graph,
    check: () => [],
  };
}

describe("bounded model explorers", () => {
  test("uses a real isolated runtime, performs reads, returns findings and accounts for usage", async () => {
    const { root, cleanup } = await fixture();
    const store = await SqliteSessionStore.open(root);
    const updates: SubagentUpdate[] = [];
    const settlements: (Session | undefined)[] = [];
    let requests = 0;
    let reads = 0;
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 32000,
      async *stream(request) {
        requests++;
        expect(request.tools.map((tool) => tool.name)).toEqual(["files_read"]);
        expect(request.messages[0]!.text).toContain("Delegated task:");
        if (requests === 1)
          yield { type: "tool-call", call: { id: "read", name: "files_read", arguments: {} } };
        else {
          expect(request.messages.some((message) => message.text.includes("source evidence"))).toBe(
            true,
          );
          yield { type: "text", text: "Findings: app.ts:1 uses a single entry point." };
        }
        yield { type: "usage", usage: { input: 100, output: 40, cached: 25 } };
        yield { type: "done" };
      },
    };
    try {
      const service = new SubagentService({
        reserve: async (_parent, tokens) => ({
          tokens,
          settle: async (session) => {
            settlements.push(session);
          },
        }),
        onEvent: (event) => {
          updates.push(event);
        },
        createRuntime: ({ settings, onEvent }) => {
          const tools = new ToolRegistry();
          tools.register({
            name: "files_read",
            kind: "read",
            eager: true,
            description: "Read",
            inputSchema: { type: "object" },
            execute: async () => {
              reads++;
              return { text: "source evidence" };
            },
          });
          return new AgentRuntime({
            root,
            provider,
            store,
            architecture: architecture(root),
            tools,
            permissions: new PermissionGate("read-only"),
            settings,
            onEvent,
          });
        },
      });
      const tool = createSubagentTool(service);
      const result = await tool.execute(
        { prompt: "Find the entry point" },
        { root, sessionId: "parent", signal: new AbortController().signal },
      );
      expect(result.isError).toBe(false);
      expect(result.text).toContain("app.ts:1");
      expect(result.fullOutput).toContain("source evidence");
      expect(reads).toBe(1);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.usage).toEqual({ input: 200, output: 80, cached: 50 });
      expect(settlements[0]!.id).not.toBe("parent");
      expect(updates.every((event) => event.parentSessionId === "parent")).toBe(true);
      expect(updates.at(-1)!.status).toBe("complete");
    } finally {
      store.close();
      await cleanup();
    }
  });

  test("bounds concurrency, propagates cancellation and settles reservations even on failure", async () => {
    const abort = new AbortController();
    let releases = 0;
    const service = new SubagentService({
      reserve: async (_parent, tokens) => ({
        tokens,
        settle: async () => {
          releases++;
        },
      }),
      createRuntime: () => ({
        currentSession: undefined,
        run: async (_prompt, signal) => {
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
          throw new Error("unreachable");
        },
      }),
    });
    const first = service.explore("one", "p", abort.signal);
    const second = service.explore("two", "p", abort.signal);
    await expect(service.explore("third", "p", abort.signal)).rejects.toThrow("Two explorers");
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(releases).toBe(2);
  });

  test("budget refusal makes no runtime/model call and does not consume a concurrency slot", async () => {
    let created = 0;
    const service = new SubagentService({
      reserve: async () => {
        throw new Error("Parent budget exhausted");
      },
      createRuntime: () => {
        created++;
        throw new Error("Should not run");
      },
    });
    for (let i = 0; i < 3; i++) {
      const result = await service.explore("Inspect", "p", new AbortController().signal);
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("Parent budget exhausted");
    }
    expect(created).toBe(0);
  });
});
