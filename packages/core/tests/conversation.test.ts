import { describe, expect, test } from "bun:test";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type ModelRequest,
  type ProviderAdapter,
  type RuntimeEvent,
  type Session,
  type SessionStore,
} from "../src/index.ts";

const architecture: ArchitectureService = {
  scan: async () => ({
    root: "/project",
    revision: "a",
    nodes: [],
    edges: [],
    cycles: [],
    diagnostics: [],
    stats: { files: 0, parsed: 0, cached: 0, durationMs: 0 },
  }),
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  writeDesign: async () => {},
  intendedGraph: () => {
    throw new Error("Not needed");
  },
  check: () => [],
};

class ConversationStore implements SessionStore {
  session?: Session;
  events: RuntimeEvent[] = [];
  snapshots: Session[] = [];
  async create(root: string, provider: ProviderAdapter, goal: string): Promise<Session> {
    this.session = {
      id: "conversation",
      root,
      provider: provider.id,
      model: provider.model,
      status: "running",
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
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
    };
    return this.session;
  }
  async get() {
    return this.session;
  }
  async list() {
    return this.session ? [this.session] : [];
  }
  async save(session: Session) {
    this.session = session;
    this.snapshots.push(structuredClone(session));
  }
  async append(event: RuntimeEvent) {
    this.events.push(event);
  }
  async pendingMutations() {
    return [];
  }
  async putArtifact() {
    return "unused";
  }
  async readArtifact() {
    return "unused";
  }
}

function runtime(provider: ProviderAdapter, store: ConversationStore) {
  return new AgentRuntime({
    root: "/project",
    provider,
    store,
    architecture,
    tools: new ToolRegistry(),
    permissions: new PermissionGate("yolo"),
    settings: { promptTokens: 6000, outputTokens: 512 },
  });
}

describe("durable human conversation", () => {
  test("keeps every message while compacting model context and streams reasoning by message ID", async () => {
    const store = new ConversationStore();
    const requests: ModelRequest[] = [];
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 32_000,
      async *stream(request) {
        requests.push(request);
        yield { type: "reasoning", text: "Visible reasoning summary" };
        yield { type: "text", text: "**Formatted answer** " + "content ".repeat(350) };
        yield { type: "done", providerData: { continuation: "opaque" } };
      },
    };
    const agent = runtime(provider, store);
    const session = await agent.run("First prompt", new AbortController().signal);
    // A human-only annotation must never become paid model context.
    session.chat![0]!.text += " HUMAN_HISTORY_SENTINEL";
    for (let index = 0; index < 8; index++)
      await agent.run(`Follow-up ${index}`, new AbortController().signal, session.id);
    expect(session.chat).toHaveLength(18);
    expect(session.chat?.filter((message) => message.role === "user")).toHaveLength(9);
    expect(new Set(session.chat!.map((message) => message.id)).size).toBe(18);
    expect(session.chat?.[1]?.reasoning).toBe("Visible reasoning summary");
    expect(session.messages[1]?.providerData).toEqual({ continuation: "opaque" });
    expect(JSON.stringify(requests)).not.toContain("HUMAN_HISTORY_SENTINEL");
    expect(store.events.some((event) => event.type === "compaction")).toBe(true);
    const assistant = session.chat![1]!;
    expect(
      store.events
        .filter((event) => event.data.messageId === assistant.id)
        .map((event) => event.type),
    ).toEqual(["message-start", "reasoning", "text", "message-end"]);
    expect(
      store.events.filter((event) => event.type === "message-start" && event.data.role === "user"),
    ).toHaveLength(9);
  });

  test("retains an interrupted response without treating it as completed provider continuation", async () => {
    const store = new ConversationStore();
    const controller = new AbortController();
    let calls = 0;
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 32_000,
      async *stream() {
        if (calls++ === 0) {
          yield { type: "text", text: "Partial answer" };
          controller.abort();
          throw new Error("Interrupted stream");
        }
        yield { type: "text", text: "Continued safely" };
        yield { type: "done" };
      },
    };
    const agent = runtime(provider, store);
    const session = await agent.run("First prompt", controller.signal);
    expect(session.status).toBe("aborted");
    expect(session.chat?.at(-1)).toMatchObject({ text: "Partial answer", status: "aborted" });
    expect(session.messages).toHaveLength(1);
    await agent.run("Continue", new AbortController().signal, session.id);
    expect(session.chat?.map((message) => message.text)).toEqual([
      "First prompt",
      "Partial answer",
      "Continue",
      "Continued safely",
    ]);
    expect(
      store.events
        .filter((event) => event.type === "message-end")
        .map((event) => event.data.status),
    ).toEqual(["aborted", "complete"]);
  });

  test("saves signed tool continuation before a complete-message client callback can fail", async () => {
    const store = new ConversationStore();
    const tools = new ToolRegistry();
    let writes = 0;
    tools.register({
      name: "write",
      description: "write",
      kind: "write",
      inputSchema: { type: "object" },
      execute: async () => {
        writes++;
        return { text: "written" };
      },
    });
    const call = { id: "signed-call", name: "write", arguments: {} };
    const continuation = {
      provider: "fake",
      model: "test",
      content: [
        { type: "thinking", thinking: "Reasoning summary", signature: "opaque-signature" },
        { type: "tool_use", id: call.id, name: call.name, input: {} },
      ],
    };
    let requests = 0;
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 32_000,
      async *stream(request) {
        if (requests++ === 0) {
          yield { type: "reasoning", text: "Reasoning summary" };
          yield { type: "tool-call", call };
          yield { type: "usage", usage: { input: 9, output: 4, cached: 2 } };
          yield { type: "done", providerData: continuation };
        } else {
          expect(request.messages.find((message) => message.providerData)?.providerData).toEqual(
            continuation,
          );
          expect(
            request.messages.some(
              (message) => message.role === "tool" && message.text.includes("Interrupted"),
            ),
          ).toBe(true);
          yield { type: "text", text: "Inspected without replaying the write" };
          yield { type: "done" };
        }
      },
    };
    let rejectPresentation = true;
    const agent = new AgentRuntime({
      root: "/project",
      provider,
      store,
      architecture,
      tools,
      permissions: new PermissionGate("yolo"),
      onEvent: (event) => {
        if (
          event.type === "message-end" &&
          event.data.status === "complete" &&
          rejectPresentation
        ) {
          rejectPresentation = false;
          const durable = store.snapshots.at(-1)!;
          expect(durable.messages.at(-1)).toMatchObject({
            providerData: continuation,
            toolCalls: [call],
          });
          expect(durable.usage).toEqual({ input: 9, output: 4, cached: 2 });
          throw new Error("Client presentation failed");
        }
      },
    });
    await expect(agent.run("Write after planning", new AbortController().signal)).rejects.toThrow(
      "Client presentation failed",
    );
    expect(store.session?.status).toBe("failed");
    expect(store.session?.messages.at(-1)?.providerData).toEqual(continuation);
    expect(store.session?.chat?.at(-1)).toMatchObject({
      reasoning: "Reasoning summary",
      status: "complete",
    });
    expect(writes).toBe(0);
    const resumed = await agent.run("", new AbortController().signal, "conversation");
    expect(resumed.status).toBe("complete");
    expect(requests).toBe(2);
    expect(writes).toBe(0);
  });

  test("persists failed response text and labels the response before reporting failure", async () => {
    const store = new ConversationStore();
    const provider: ProviderAdapter = {
      id: "fake",
      model: "test",
      contextWindow: 32_000,
      async *stream() {
        yield { type: "text", text: "Before network failure" };
        throw new Error("Network failure");
      },
    };
    await expect(
      runtime(provider, store).run("Prompt", new AbortController().signal),
    ).rejects.toThrow("Network failure");
    expect(store.session?.chat?.at(-1)).toMatchObject({
      text: "Before network failure",
      status: "failed",
    });
    expect(store.session?.status).toBe("failed");
    const ending = store.events.findIndex((event) => event.type === "message-end");
    const failure = store.events.findIndex((event) => event.type === "status");
    expect(ending).toBeGreaterThan(0);
    expect(failure).toBeGreaterThan(ending);
  });
});
