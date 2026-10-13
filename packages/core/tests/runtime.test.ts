import { describe, expect, test } from "bun:test";
import {
  AgentRuntime,
  balanced,
  boundText,
  BudgetContextPlanner,
  estimateTokens,
  PermissionGate,
  ToolRegistry,
  diffGraph,
  type ArchitectureGraph,
  type ArchitectureService,
  type ModelEvent,
  type ProviderAdapter,
  type RuntimeEvent,
  type Session,
  type SessionStore,
} from "../src/index.ts";

const graph: ArchitectureGraph = {
  root: "/project",
  revision: "a",
  nodes: [{ id: "a", label: "app", kind: "module", path: "app.ts" }],
  edges: [],
  cycles: [],
  diagnostics: [],
  stats: { files: 1, parsed: 1, cached: 0, durationMs: 1 },
};
const architecture: ArchitectureService = {
  scan: async () => graph,
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  writeDesign: async () => {},
  intendedGraph: () => graph,
  check: () => [],
};
class MemoryStore implements SessionStore {
  session?: Session;
  events: RuntimeEvent[] = [];
  artifacts: string[] = [];
  async create(root: string, provider: ProviderAdapter, goal: string): Promise<Session> {
    return (this.session = {
      id: "session",
      root,
      provider: provider.id,
      model: provider.model,
      status: "running",
      createdAt: "now",
      updatedAt: "now",
      messages: [],
      ledger: {
        goal,
        constraints: [],
        decisions: [],
        pending: [],
        touchedPaths: [],
        verification: [],
      },
      usage: { input: 0, output: 0, cached: 0 },
    });
  }
  async get() {
    return this.session;
  }
  async list() {
    return this.session ? [this.session] : [];
  }
  async save(session: Session) {
    this.session = session;
  }
  async append(event: RuntimeEvent) {
    this.events.push(event);
  }
  async putArtifact(_id: string, content: string) {
    this.artifacts.push(content);
    return String(this.artifacts.length - 1);
  }
  async readArtifact(id: string) {
    return this.artifacts[Number(id)]!;
  }
  async pendingMutations() {
    const calls = new Map<string, string>();
    for (const e of this.events) {
      if (e.type === "tool-start" && e.data.kind !== "read")
        calls.set(String(e.data.callId), String(e.data.name));
      if (e.type === "tool-end") calls.delete(String(e.data.callId));
    }
    return [...calls.values()];
  }
}
function scripted(turns: ModelEvent[][]): ProviderAdapter {
  let index = 0;
  return {
    id: "fake",
    model: "test",
    contextWindow: 64_000,
    async *stream() {
      for (const event of turns[index++] ?? [{ type: "done" }]) yield event;
    },
  };
}
describe("harness boundaries", () => {
  test("cancellation drains every concurrent read before the runtime returns", async () => {
    const controller = new AbortController();
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let drained = false;
    for (const name of ["fast", "slow"])
      tools.register({
        name,
        description: name,
        kind: "read",
        eager: true,
        inputSchema: { type: "object" },
        execute: async () => {
          if (name === "fast") {
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.abort();
            throw new Error("Canceled");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          drained = true;
          throw new Error("Canceled after durable child settlement");
        },
      });
    const runtime = new AgentRuntime({
      root: "/project",
      architecture,
      store,
      tools,
      permissions: new PermissionGate("yolo"),
      provider: scripted([
        [
          ...["fast", "slow"].map((name) => ({
            type: "tool-call" as const,
            call: { id: name, name, arguments: {} },
          })),
        ],
      ]),
    });
    const session = await runtime.run("Read concurrently", controller.signal);
    expect(session.status).toBe("aborted");
    expect(drained).toBe(true);
    const cards = session.chat?.filter((message) => message.role === "tool") ?? [];
    expect(cards).toHaveLength(2);
    expect(cards.every((message) => message.tool?.state === "interrupted")).toBe(true);
    expect(cards.every((message) => message.status === "aborted")).toBe(true);
    expect(cards.every((message) => message.text.includes("No completion was recorded"))).toBe(
      true,
    );
    expect(
      store.session?.chat?.filter((message) => message.tool?.state === "running"),
    ).toHaveLength(0);
  });
  test("Unicode results remain inside byte-estimated budgets without broken characters", () => {
    for (const budget of [0, 1, 10, 20, 200, 3000]) {
      const text = boundText("Архитектура 🧩 中文 ".repeat(3000), budget);
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      expect(text).not.toContain("�");
    }
  });
  test("validates arguments before running tools", async () => {
    const tools = new ToolRegistry();
    let called = false;
    tools.register({
      name: "read",
      description: "read",
      kind: "read",
      eager: true,
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      execute: async () => {
        called = true;
        return { text: "ok" };
      },
    });
    await expect(
      tools.execute(
        { id: "x", name: "read", arguments: {} },
        { root: "/project", sessionId: "s", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Invalid arguments");
    expect(called).toBe(false);
  });
  test("1000 lazy tools do not increase the eager prompt", () => {
    const tools = new ToolRegistry();
    for (let i = 0; i < 1000; i++)
      tools.register({
        name: `tool_${i}`,
        description: `service ${i}`,
        kind: "execute",
        inputSchema: { type: "object" },
        execute: async () => ({ text: "ok" }),
      });
    tools.register({
      name: "search",
      description: "discover tools",
      eager: true,
      kind: "read",
      inputSchema: { type: "object" },
      execute: async () => ({ text: "ok" }),
    });
    expect(tools.schemas(4000).length).toBe(1);
    expect(estimateTokens(JSON.stringify(tools.schemas(4000)))).toBeLessThan(4000);
  });
  test("all permission modes share one boundary", async () => {
    const tool = {
      name: "write",
      kind: "write" as const,
      description: "write",
      inputSchema: {},
      execute: async () => ({ text: "ok" }),
    };
    await new PermissionGate("yolo").authorize(tool, {});
    await expect(new PermissionGate("read-only").authorize(tool, {})).rejects.toThrow("denies");
    await expect(new PermissionGate("ask", async () => false).authorize(tool, {})).rejects.toThrow(
      "denied",
    );
    await new PermissionGate("ask", async () => true).authorize(tool, {});
  });
  test("keeps full artifacts, model bounds, and opaque provider data separate", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "read",
      eager: true,
      description: "read",
      kind: "read",
      inputSchema: { type: "object" },
      execute: async () => ({ text: "X".repeat(100_000), fullOutput: "COMPLETE".repeat(100_000) }),
    });
    const provider = scripted([
      [
        { type: "tool-call", call: { id: "c", name: "read", arguments: {} } },
        { type: "usage", usage: { input: 10, output: 3, cached: 4 } },
        { type: "done", providerData: { signature: "opaque" } },
      ],
      [{ type: "text", text: "done" }, { type: "done" }],
    ]);
    const runtime = new AgentRuntime({
      root: "/project",
      provider,
      tools,
      architecture,
      store,
      permissions: new PermissionGate("yolo"),
    });
    const session = await runtime.run("inspect", new AbortController().signal);
    expect(session.status).toBe("complete");
    expect(session.usage).toEqual({ input: 10, output: 3, cached: 4 });
    expect(session.messages[1]!.providerData).toEqual({ signature: "opaque" });
    expect(session.messages.find((m) => m.role === "tool")!.text.length).toBeLessThan(10_000);
    expect(store.artifacts[0]!.length).toBe(800_000);
  });
  test("stops before a model request when task budget cannot fit it", async () => {
    const store = new MemoryStore();
    let requests = 0;
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 64_000,
      async *stream() {
        requests++;
        yield { type: "done" };
      },
    };
    const session = await new AgentRuntime({
      root: "/project",
      provider,
      architecture,
      tools: new ToolRegistry(),
      store,
      permissions: new PermissionGate("yolo"),
      settings: { taskTokens: 100 },
    }).run("task", new AbortController().signal);
    expect(session.status).toBe("budget");
    expect(requests).toBe(0);
  });
  test("missing provider usage still consumes a durable task budget reservation", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let requests = 0;
    tools.register({
      name: "read",
      description: "read",
      kind: "read",
      eager: true,
      inputSchema: { type: "object" },
      execute: async () => ({ text: "ok" }),
    });
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 64_000,
      async *stream() {
        requests++;
        yield { type: "tool-call", call: { id: "call", name: "read", arguments: {} } };
        yield { type: "done" };
      },
    };
    const runtime = new AgentRuntime({
      root: "/project",
      provider,
      architecture,
      tools,
      store,
      permissions: new PermissionGate("yolo"),
      settings: { taskTokens: 8000 },
    });
    const session = await runtime.run("inspect", new AbortController().signal);
    expect(requests).toBe(1);
    expect(session.status).toBe("budget");
    expect(session.usage.input).toBe(0);
    expect(session.budgetSpent).toBe(8000);
    await runtime.run("resume", new AbortController().signal, session.id);
    expect(requests).toBe(1);
  });
  test("interrupted mutation is inspected on resume, never replayed", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const controller = new AbortController();
    let writes = 0;
    tools.register({
      name: "write",
      description: "write",
      kind: "write",
      eager: true,
      inputSchema: { type: "object" },
      execute: async () => {
        writes++;
        controller.abort();
        throw new Error("Interrupted after side effect");
      },
    });
    const runtime = new AgentRuntime({
      root: "/project",
      provider: scripted([
        [{ type: "tool-call", call: { id: "c", name: "write", arguments: {} } }, { type: "done" }],
        [{ type: "done" }],
      ]),
      tools,
      architecture,
      store,
      permissions: new PermissionGate("yolo"),
    });
    expect((await runtime.run("write", controller.signal)).status).toBe("aborted");
    const resumed = await runtime.run("inspect outcome", new AbortController().signal, "session");
    expect(writes).toBe(1);
    expect(resumed.ledger.constraints.join(" ")).toContain("uncertain outcome");
    expect(resumed.messages.some((m) => m.role === "tool" && m.text.includes("Interrupted"))).toBe(
      true,
    );
  });
  test("compaction preserves decisions and tool groups", async () => {
    const store = new MemoryStore();
    const session = await store.create("/project", scripted([]), "build service");
    session.ledger.constraints = ["Use only local storage"];
    session.ledger.decisions = ["API must remain compatible"];
    for (let i = 0; i < 20; i++)
      session.messages.push(
        {
          role: "assistant",
          text: "old".repeat(3000),
          toolCalls: [{ id: String(i), name: "read", arguments: {} }],
        },
        { role: "tool", toolCallId: String(i), text: "result".repeat(1000) },
      );
    session.messages.push({ role: "user", text: "finish" });
    const request = new BudgetContextPlanner().build(
      session,
      graph,
      [],
      { ...balanced, promptTokens: 8000, outputTokens: 1000 },
      32_000,
    );
    expect(JSON.stringify(request)).toContain("Use only local storage");
    expect(JSON.stringify(request)).toContain("API must remain compatible");
    for (const m of request.messages)
      for (const call of m.toolCalls ?? [])
        expect(request.messages.some((result) => result.toolCallId === call.id)).toBe(true);
    expect(estimateTokens(JSON.stringify(request))).toBeLessThan(8000);
  });
  test("graph changes retain removed modules and added relations", () => {
    const next = {
      ...graph,
      revision: "b",
      nodes: [{ id: "b", label: "db", kind: "module" as const }],
      edges: [],
    };
    const diff = diffGraph(graph, next);
    expect(diff.nodes.find((n) => n.id === "a")?.change).toBe("removed");
    expect(diff.nodes.find((n) => n.id === "b")?.change).toBe("added");
  });
});
