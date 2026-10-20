import { describe, expect, test } from "bun:test";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  ToolValidationError,
  type ArchitectureGraph,
  type ArchitectureService,
  type ProviderAdapter,
  type RuntimeEvent,
  type Session,
  type SessionStore,
  type ToolCall,
  type ToolKind,
} from "../src/index.ts";

const graph: ArchitectureGraph = {
  root: "/project",
  revision: "test",
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

class SnapshotStore implements SessionStore {
  snapshot?: Session;
  events: RuntimeEvent[] = [];
  artifacts: string[] = [];
  async create(root: string, provider: ProviderAdapter, goal: string): Promise<Session> {
    return {
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
    };
  }
  async get() {
    return structuredClone(this.snapshot);
  }
  async list() {
    return this.snapshot ? [structuredClone(this.snapshot)] : [];
  }
  async save(session: Session) {
    this.snapshot = structuredClone(session);
  }
  async append(event: RuntimeEvent) {
    this.events.push(structuredClone(event));
  }
  async putArtifact(_id: string, text: string) {
    this.artifacts.push(text);
    return String(this.artifacts.length - 1);
  }
  async readArtifact(id: string) {
    return this.artifacts[Number(id)]!;
  }
  async pendingMutations() {
    return [];
  }
}

function call(id: string, version: unknown = "1", name = "propose"): ToolCall {
  return { id, name, arguments: { version, note: id } };
}

function fixture(turns: ToolCall[][], kind: ToolKind = "write") {
  const store = new SnapshotStore();
  const tools = new ToolRegistry();
  const counts = { requests: 0, effects: 0, approvals: 0, wrappers: 0 };
  tools.register({
    name: "propose",
    kind,
    description: "Propose",
    eager: true,
    inputSchema: {
      type: "object",
      properties: { version: { const: 1, type: "integer" }, note: { type: "string" } },
      required: ["version"],
    },
    execute: async () => {
      counts.effects++;
      return { text: "Applied" };
    },
  });
  const provider: ProviderAdapter = {
    id: "fake",
    model: "test",
    contextWindow: 64_000,
    async *stream() {
      for (const item of turns[counts.requests++] ?? []) yield { type: "tool-call", call: item };
      yield { type: "done" };
    },
  };
  const options = {
    root: "/project",
    provider,
    store,
    tools,
    architecture,
    permissions: new PermissionGate("ask", async () => {
      counts.approvals++;
      return true;
    }),
    executeTool: async (
      _call: ToolCall,
      _context: unknown,
      execute: () => Promise<{ text: string }>,
    ) => {
      counts.wrappers++;
      return execute();
    },
  };
  return { store, tools, counts, options, runtime: new AgentRuntime(options) };
}

const signal = () => new AbortController().signal;

describe("invalid tool request limiter", () => {
  test("stops repeated schema mistakes despite changed irrelevant arguments before effects or approvals", async () => {
    const f = fixture([[call("a")], [call("b")], [call("c")], [call("never", 1)]]);
    const session = await f.runtime.run("Implement", signal());
    expect(session.status).toBe("failed");
    expect(f.counts).toEqual({ requests: 3, effects: 0, approvals: 0, wrappers: 0 });
    expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    expect(f.store.events.filter((event) => event.type === "tool-request")).toHaveLength(3);
    expect(f.store.events.filter((event) => event.type === "tool-end")).toHaveLength(3);
    expect(session.invalidToolRequests?.blocked?.reason).toContain("Stopped after 3");
    expect(session.chat?.find((message) => message.tool?.callId === "c")?.tool?.state).toBe(
      "blocked",
    );
    const end = f.store.events.find((event) => event.type === "tool-end")!;
    expect(end.data.arguments).toEqual({ version: "1", note: "a" });
    expect(end.data.kind).toBe("write");
  });

  test("valid correction resets the tool counters; runtime failures do not count", async () => {
    const f = fixture([
      [call("a")],
      [call("b")],
      [call("corrected", 1)],
      [call("d")],
      [call("e")],
      [],
    ]);
    f.options.executeTool = async () => {
      f.counts.wrappers++;
      throw new Error("Execution failed");
    };
    f.options.permissions = new PermissionGate("ask", async () => {
      f.counts.approvals++;
      expect(f.store.snapshot?.invalidToolRequests?.failures).toEqual([]);
      return true;
    });
    const session = await new AgentRuntime(f.options).run("Implement", signal());
    expect(session.status).toBe("complete");
    expect(f.counts).toEqual({ requests: 6, effects: 0, approvals: 1, wrappers: 1 });
    expect(session.invalidToolRequests?.blocked).toBeUndefined();
    expect(session.invalidToolRequests?.failures.every((failure) => failure.attempts === 2)).toBe(
      true,
    );
  });

  test("permission denials never consume invalid-argument attempts", async () => {
    const f = fixture([[call("a", 1)], [call("b", 1)], [call("c", 1)], []]);
    const session = await new AgentRuntime({
      ...f.options,
      permissions: new PermissionGate("ask", async () => false),
    }).run("Implement", signal());
    expect(session.status).toBe("complete");
    expect(session.invalidToolRequests).toBeUndefined();
    expect(f.counts.effects).toBe(0);
    expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
  });

  test("retry counts survive an empty resume before reaching the limit", async () => {
    const f = fixture([[call("a")], [call("b")], [call("c")]]);
    const paused = await new AgentRuntime({ ...f.options, settings: { maxTurns: 1 } }).run(
      "Implement",
      signal(),
    );
    expect(paused.status).toBe("budget");
    expect(f.store.snapshot?.invalidToolRequests?.failures[0]?.attempts).toBe(1);
    const resumed = await new AgentRuntime(f.options).run("", signal(), "session");
    expect(resumed.status).toBe("failed");
    expect(f.counts.requests).toBe(3);
    expect(f.counts.effects).toBe(0);
  });

  test("problem signatures never store actual argument values or unexpected property names", () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "strict",
      kind: "read",
      description: "Strict",
      inputSchema: {
        type: "object",
        properties: { version: { type: "integer", const: 1 } },
        additionalProperties: false,
      },
      execute: async () => ({ text: "ok" }),
    });
    const signatures: string[][] = [];
    for (const secret of ["SECRET_A", "SECRET_B"])
      try {
        tools.validate({
          id: secret,
          name: "strict",
          arguments: { version: secret, [secret]: secret },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ToolValidationError);
        signatures.push((error as ToolValidationError).signatures);
      }
    expect(signatures[0]).toEqual(signatures[1]);
    expect(JSON.stringify(signatures)).not.toContain("SECRET");
  });

  test("presentation tool details never enter the provider context", async () => {
    const f = fixture([[call("read", 1)], []], "read");
    const requests: string[] = [];
    const provider: ProviderAdapter = {
      ...f.options.provider,
      async *stream(request, abortSignal) {
        requests.push(JSON.stringify(request));
        yield* f.options.provider.stream(request, abortSignal);
      },
    };
    const runtime = new AgentRuntime({
      ...f.options,
      provider,
      onEvent: (event) => {
        if (event.type === "tool-end") {
          const preview = runtime.currentSession?.chat?.find((message) => message.role === "tool");
          if (preview) {
            preview.text += " UI_ONLY_SENTINEL";
            preview.tool!.input += " UI_ONLY_ARGUMENT_SENTINEL";
          }
        }
      },
    });
    await runtime.run("Read", signal());
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Applied");
    expect(requests[1]).not.toContain("UI_ONLY");
    expect(
      runtime.currentSession?.chat?.some((message) => message.text.includes("UI_ONLY_SENTINEL")),
    ).toBe(true);
  });

  test("provider result and terminal tool card share a durable snapshot before tool-end publication", async () => {
    const f = fixture([[call("write", 1)], []]);
    const append = f.store.append.bind(f.store);
    let checked = false;
    f.store.append = async (event) => {
      if (event.type === "tool-end") {
        checked = true;
        const snapshot = f.store.snapshot!;
        const tool = snapshot.chat?.find((message) => message.tool?.callId === "write");
        expect(tool?.tool?.state).toBe("complete");
        expect(tool?.tool?.artifact).toBe(event.data.artifact as string);
        expect(snapshot.messages.find((message) => message.toolCallId === "write")?.text).toContain(
          "Applied",
        );
        expect(await f.store.readArtifact(tool!.tool!.artifact!)).toBe("Applied");
      }
      await append(event);
    };
    await f.runtime.run("Implement", signal());
    expect(checked).toBe(true);
  });

  test("closes every call group and skips remaining batch mutations when the limit is reached", async () => {
    const f = fixture([
      [call("a"), call("b"), call("c"), call("skip", 1), call("unknown", 1, "missing")],
    ]);
    const session = await f.runtime.run("Implement", signal());
    expect(session.status).toBe("failed");
    expect(f.counts.effects).toBe(0);
    expect(f.counts.approvals).toBe(0);
    expect(session.messages.filter((message) => message.role === "tool")).toHaveLength(5);
    expect(
      f.store.events.filter((event) => event.type === "tool-end" && event.data.blocked),
    ).toHaveLength(3);
    expect(f.counts.requests).toBe(1);
  });

  test("reconciles architecture after an earlier successful mutation before stopping inference", async () => {
    const f = fixture([[call("written", 1), call("a"), call("b"), call("c")]]);
    let scans = 0;
    const session = await new AgentRuntime({
      ...f.options,
      architecture: {
        ...architecture,
        scan: async () => ({ ...graph, revision: String(++scans) }),
      },
    }).run("Implement", signal());
    expect(session.status).toBe("failed");
    expect(f.counts.effects).toBe(1);
    expect(f.counts.requests).toBe(1);
    expect(scans).toBe(2);
    expect(
      f.store.events.filter((event) => event.type === "architecture").at(-1)?.data.revision,
    ).toBe("2");
  });

  test("drains active concurrent reads, records their results, and skips the following write", async () => {
    const f = fixture(
      [[call("slow", 1), call("a"), call("b"), call("c"), call("skip", 1, "write")]],
      "read",
    );
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let drained = false;
    f.tools.register({
      name: "write",
      description: "Write",
      kind: "write",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new Error("Must not execute");
      },
    });
    const session = await new AgentRuntime({
      ...f.options,
      onEvent: async (event) => {
        if (event.type === "tool-request" && event.data.callId === "a") await running;
      },
      executeTool: async (_call, _context, execute) => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 20));
        drained = true;
        return execute();
      },
    }).run("Implement", signal());
    expect(session.status).toBe("failed");
    expect(drained).toBe(true);
    expect(f.counts.effects).toBe(1);
    expect(session.messages.filter((message) => message.role === "tool")).toHaveLength(5);
    expect(session.messages.find((message) => message.toolCallId === "slow")?.text).toContain(
      "Applied",
    );
    expect(
      f.store.events.filter((event) => event.type === "tool-end" && event.data.blocked),
    ).toHaveLength(2);
    expect(f.counts.approvals).toBe(0);
  });

  test("empty restart stays blocked without inference; a new human prompt permits a corrected request", async () => {
    const f = fixture([[call("a")], [call("b")], [call("c")], [call("corrected", 1)], []]);
    await f.runtime.run("Implement", signal());
    const blocked = await new AgentRuntime(f.options).run("", signal(), "session");
    expect(blocked.status).toBe("failed");
    expect(f.counts.requests).toBe(3);
    expect(blocked.chat?.filter((message) => message.role === "tool")).toHaveLength(3);
    const retry = await new AgentRuntime(f.options).run(
      "Use numeric version 1",
      signal(),
      "session",
    );
    expect(retry.status).toBe("complete");
    expect(f.counts.effects).toBe(1);
    expect(f.counts.requests).toBe(5);
    expect(retry.invalidToolRequests?.blocked).toBeUndefined();
  });

  test("unfinished blocked batches are closed on empty restart without replaying effects", async () => {
    const f = fixture([[call("a")], [call("b")], [call("c")]]);
    await f.runtime.run("Implement", signal());
    const snapshot = f.store.snapshot!;
    snapshot.messages.push({ role: "assistant", text: "", toolCalls: [call("unrecorded", 1)] });
    const session = await new AgentRuntime(f.options).run("", signal(), "session");
    expect(f.counts.requests).toBe(3);
    expect(f.counts.effects).toBe(0);
    expect(session.messages.find((message) => message.toolCallId === "unrecorded")?.text).toContain(
      "Interrupted",
    );
    expect(
      f.store.events.find(
        (event) => event.type === "tool-end" && event.data.callId === "unrecorded",
      )?.data.interrupted,
    ).toBe(true);
  });
});
