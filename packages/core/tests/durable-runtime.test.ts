import { describe, expect, test } from "bun:test";
import {
  AgentRuntime,
  createRunPlan,
  PermissionGate,
  ToolRegistry,
  resolveRunApproval,
  resolveRunUncertainty,
  type ArchitectureGraph,
  type ArchitectureService,
  type ModelEvent,
  type ProviderAdapter,
  type RuntimeEvent,
  type RuntimeOptions,
  type Session,
  type SessionStore,
  type ToolCall,
  type ToolKind,
} from "../src/index.ts";

const graph: ArchitectureGraph = {
  root: "/project",
  revision: "1",
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
      id: "run",
      root,
      provider: provider.id,
      model: provider.model,
      status: "running",
      createdAt: "now",
      updatedAt: "now",
      messages: [],
      usage: { input: 0, output: 0, cached: 0 },
      ledger: {
        goal,
        constraints: [],
        decisions: [],
        pending: [],
        touchedPaths: [],
        verification: [],
      },
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
  async putArtifact(_id: string, content: string) {
    this.artifacts.push(content);
    return String(this.artifacts.length - 1);
  }
  async readArtifact(id: string) {
    return this.artifacts[Number(id)]!;
  }
  async pendingMutations() {
    return [];
  }
}
const call = (id: string, name = "write", arguments_: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  arguments: arguments_,
});
function fixture(turns: ToolCall[][], kind: ToolKind = "write") {
  const store = new SnapshotStore();
  const tools = new ToolRegistry();
  const effects: string[] = [];
  const counts = { requests: 0 };
  tools.register({
    name: kind === "read" ? "read" : "write",
    kind,
    description: "fixture",
    eager: true,
    inputSchema: { type: "object" },
    execute: async (_args, context) => {
      expect(
        Object.values(store.snapshot!.runState!.calls).some((entry) => entry.status === "started"),
      ).toBe(true);
      expect(context.resultBytes).toBeGreaterThan(0);
      effects.push(kind);
      return { text: "ok" };
    },
  });
  const provider: ProviderAdapter = {
    id: "fake",
    model: "fake",
    contextWindow: 64_000,
    async *stream() {
      const batch = turns[counts.requests++] ?? [];
      for (const item of batch) yield { type: "tool-call", call: item } satisfies ModelEvent;
      yield { type: "done" };
    },
  };
  const options: RuntimeOptions = {
    root: "/project",
    provider,
    architecture,
    store,
    tools,
    permissions: new PermissionGate("yolo"),
  };
  return { store, tools, effects, counts, options, signal: new AbortController().signal };
}

describe("durable execution in the regular runtime", () => {
  test("all four counters are durable; model exhaustion prevents a request after resume", async () => {
    const f = fixture([[call("a")]]);
    f.options.runLimits = { modelRequests: 1 };
    const first = await new AgentRuntime(f.options).run("Work", f.signal);
    expect(first.status).toBe("budget");
    expect(first.runState?.counters).toEqual({
      modelRequests: 1,
      toolCalls: 1,
      sideEffects: 1,
      resultBytes: 2,
    });
    const resumed = await new AgentRuntime({ ...f.options, runLimits: { modelRequests: 100 } }).run(
      "",
      f.signal,
      first.id,
    );
    expect(resumed.status).toBe("budget");
    expect(f.counts.requests).toBe(1);
    expect(resumed.runState?.limits.modelRequests).toBe(1);
  });
  for (const limit of ["toolCalls", "sideEffects", "resultBytes"] as const)
    test(`${limit} preflights a whole model batch before any effect`, async () => {
      const f = fixture([[call("a"), call("b")]]);
      f.options.runLimits = { [limit]: 1 };
      const run = await new AgentRuntime(f.options).run("Work", f.signal);
      expect(run.status).toBe("budget");
      expect(f.effects).toHaveLength(0);
      expect(run.runState?.counters.toolCalls).toBe(0);
      expect(run.runState?.counters.sideEffects).toBe(0);
      expect(run.runState?.counters.resultBytes).toBe(0);
      expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    });
  test("hooks and lazy external startup cannot hide side effects behind a read tool", async () => {
    const f = fixture([[call("a", "read")]], "read");
    f.options.runLimits = { sideEffects: 0 };
    f.options.sideEffectCost = () => 1;
    let wrappers = 0;
    f.options.executeTool = async (_call, _context, execute) => {
      wrappers++;
      return execute();
    };
    const run = await new AgentRuntime(f.options).run("Read with hooks", f.signal);
    expect(run.status).toBe("budget");
    expect(f.effects).toHaveLength(0);
    expect(wrappers).toBe(0);
    expect(run.runState?.counters.sideEffects).toBe(0);
  });
  test("unknown result receives the remainder and UTF-8 artifacts are capped and marked incomplete", async () => {
    const f = fixture([[call("a", "large")], [call("b", "large")], [call("c", "large")]]);
    const allowances: number[] = [];
    f.tools.register({
      name: "large",
      description: "large",
      kind: "read",
      eager: true,
      inputSchema: { type: "object" },
      execute: async (_args, context) => {
        allowances.push(context.resultBytes!);
        return {
          text: "🧩".repeat(100),
          fullOutput: "🧩".repeat(100),
          details: "oversized".repeat(100),
        };
      },
    });
    f.options.runLimits = { resultBytes: 64 };
    const run = await new AgentRuntime(f.options).run("Read", f.signal);
    expect(allowances[0]).toBe(64);
    expect(new TextEncoder().encode(f.store.artifacts[0]!).length).toBeLessThanOrEqual(64);
    expect(f.store.artifacts[0]).not.toContain("�");
    expect(f.store.artifacts[0]).toContain("incomplete");
    expect(run.messages.find((message) => message.role === "tool")?.text).toContain("incomplete");
    expect(run.status).toBe("budget");
    expect(run.runState?.counters.resultBytes).toBe(64);
  });
  for (const kind of ["read", "write"] as const)
    test(`a large ${kind} result cannot consume the last byte reserved for its batch sibling`, async () => {
      const f = fixture([[call("a", "large"), call("b", "large")]], kind);
      const allowances: number[] = [];
      f.tools.register({
        name: "large",
        kind,
        description: "Bounded unknown output",
        eager: true,
        inputSchema: { type: "object" },
        execute: async (_args, context) => {
          allowances.push(context.resultBytes!);
          return { text: "x".repeat(100) };
        },
      });
      f.options.runLimits = { resultBytes: 2 };
      const run = await new AgentRuntime(f.options).run("Work", f.signal);
      expect(allowances).toEqual([1, 1]);
      expect(run.status).toBe("complete");
      expect(run.runState?.counters.resultBytes).toBe(2);
      expect(run.runState?.pending).toEqual([]);
      expect(
        f.store.artifacts.every((output) => new TextEncoder().encode(output).length <= 1),
      ).toBe(true);
    });
  test("repeated identical call IDs execute once even in a parallel batch and resume", async () => {
    const f = fixture([[call("a", "read"), call("a", "read")], [call("a", "read")]], "read");
    const first = await new AgentRuntime(f.options).run("Read", f.signal);
    expect(f.effects).toHaveLength(1);
    expect(first.runState?.counters.toolCalls).toBe(1);
    expect(first.runState?.pending).toEqual([]);
    await new AgentRuntime({
      ...f.options,
      provider: {
        ...f.options.provider,
        async *stream() {
          yield { type: "tool-call", call: call("a", "read") };
          yield { type: "done" };
        },
      },
      settings: { maxTurns: 1 },
    }).run("", f.signal, first.id);
    expect(f.effects).toHaveLength(1);
  });
  test("a reused ID with different arguments rejects the entire batch as a protocol error", async () => {
    const f = fixture([
      [call("a", "write", { a: 1 })],
      [call("new"), call("a", "write", { a: 2 })],
    ]);
    await expect(new AgentRuntime(f.options).run("Work", f.signal)).rejects.toThrow(
      "protocol error",
    );
    expect(f.effects).toHaveLength(1);
    expect(f.store.snapshot?.runState?.counters.toolCalls).toBe(1);
  });
  test("duplicate IDs with different explicitly requested tasks reject a batch before any effect", async () => {
    const f = fixture([
      [
        { ...call("a"), taskId: "first" },
        { ...call("a"), taskId: "second" },
      ],
    ]);
    await expect(new AgentRuntime(f.options).run("Write", f.signal)).rejects.toThrow(
      "protocol error",
    );
    expect(f.effects).toEqual([]);
    expect(f.store.snapshot?.runState?.counters.toolCalls).toBe(0);
  });
  for (const legacy of [false, true])
    test(`changed explicit task identity rejects reuse across ${legacy ? "legacy" : "current"} snapshots`, async () => {
      const f = fixture([[{ ...call("a"), taskId: "first" }]]);
      const run = await new AgentRuntime(f.options).run("Write", f.signal);
      if (legacy) {
        const entry = run.runState!.calls.a!;
        delete entry.requestedTaskId;
        const signature = JSON.parse(entry.signature);
        delete signature.taskId;
        entry.signature = JSON.stringify(signature);
        await f.store.save(run);
      }
      const provider: ProviderAdapter = {
        ...f.options.provider,
        async *stream() {
          yield { type: "tool-call", call: { ...call("a"), taskId: "second" } };
          yield { type: "done" };
        },
      };
      await expect(
        new AgentRuntime({ ...f.options, provider }).run("", f.signal, run.id),
      ).rejects.toThrow("protocol error");
      expect(f.effects).toEqual(["write"]);
      expect(f.store.snapshot?.runState?.counters.toolCalls).toBe(1);
    });
  for (const legacy of [false, true])
    test(`automatic task attribution survives approval resume and duplicate replay for ${legacy ? "legacy" : "current"} snapshots`, async () => {
      const f = fixture([[call("a")], [call("a")]]);
      f.options.permissions = new PermissionGate("ask");
      const prior = await f.store.create("/project", f.options.provider, "Write");
      prior.mode = "build";
      prior.plan = createRunPlan(
        {
          goal: "Write",
          doneWhen: "Verified",
          risks: [],
          assumptions: [],
          steps: [
            {
              id: "task",
              description: "Write",
              dependencies: [],
              tools: ["write"],
              doneWhen: "Verified",
              verificationTool: "write",
            },
          ],
        },
        "build",
      );
      await f.store.save(prior);
      const waiting = await new AgentRuntime(f.options).run("", f.signal, prior.id);
      expect(waiting.status).toBe("awaiting-approval");
      const entry = waiting.runState!.calls.a!;
      expect(entry.call.taskId).toBe("task");
      expect(entry.requestedTaskId).toBeNull();
      if (legacy) delete entry.requestedTaskId;
      await resolveRunApproval(waiting, "a", true, () => f.store.save(waiting));
      const resumed = await new AgentRuntime(f.options).run("", f.signal, waiting.id);
      expect(f.effects).toEqual(["write"]);
      expect(resumed.runState?.calls.a?.status).toBe("complete");
      expect(resumed.runState?.calls.a?.call.taskId).toBe("task");
      expect(resumed.runState?.counters.toolCalls).toBe(1);
      expect(resumed.plan?.steps[0]?.evidence).toEqual([
        { callId: "a", tool: "write", succeeded: true, summary: "ok" },
      ]);
    });
  test("crash after read effect retains charged output, resumes uncertain and explicit retry is a new attempt", async () => {
    const f = fixture([[call("a", "read")]], "read");
    f.options.runLimits = { resultBytes: 100 };
    f.options.afterToolEffect = async () => {
      throw new Error("Injected crash after effects");
    };
    await expect(new AgentRuntime(f.options).run("Read", f.signal)).rejects.toThrow(
      "Injected crash",
    );
    expect(f.effects).toHaveLength(1);
    expect(f.store.snapshot?.runState?.counters.resultBytes).toBe(100);
    const resumed = await new AgentRuntime({ ...f.options, afterToolEffect: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(resumed.status).toBe("uncertain");
    expect(f.counts.requests).toBe(1);
    expect(f.effects).toHaveLength(1);
    await resolveRunUncertainty(resumed, "a", "retry", { save: () => f.store.save(resumed) });
    const retry = await new AgentRuntime({ ...f.options, afterToolEffect: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(retry.status).toBe("budget"); // A crash never refunds the output reservation.
    expect(f.effects).toHaveLength(1);
    expect(retry.runState?.counters.resultBytes).toBe(100);
  });
  test("an executor that mutates and throws blocks later effects and retains its unknown output charge", async () => {
    const f = fixture([[call("a", "throws"), call("b")]]);
    f.tools.register({
      name: "throws",
      kind: "write",
      description: "Mutation with an unavailable response",
      eager: true,
      inputSchema: { type: "object" },
      execute: async () => {
        f.effects.push("mutation applied");
        throw new Error("Connection lost after mutation");
      },
    });
    f.options.runLimits = { resultBytes: 4096 };
    f.options.resultBytesPerCall = 1024;
    const run = await new AgentRuntime(f.options).run("Write", f.signal);
    expect(run.status).toBe("uncertain");
    expect(f.effects).toEqual(["mutation applied"]);
    expect(run.runState?.calls.a?.status).toBe("uncertain");
    expect(run.runState?.calls.b?.status).toBe("reserved");
    expect(run.runState?.counters.resultBytes).toBe(1025); // Includes the pending call's byte.
    expect(run.messages.find((message) => message.role === "tool")?.text).toContain(
      "Connection lost after mutation",
    );
    expect(run.messages.find((message) => message.role === "tool")?.text).toContain(
      "Outcome uncertain",
    );
    const resumed = await new AgentRuntime(f.options).run("", f.signal, run.id);
    expect(resumed.status).toBe("uncertain");
    expect(f.effects).toEqual(["mutation applied"]);
    expect(f.counts.requests).toBe(1);
    await expect(
      resolveRunUncertainty(resumed, "a", "retry", { save: () => f.store.save(resumed) }),
    ).rejects.toThrow("cannot be safely repeated");
    await resolveRunUncertainty(resumed, "a", "fail", {
      save: () => f.store.save(resumed),
    });
    const resolved = await new AgentRuntime(f.options).run("", f.signal, run.id);
    expect(resolved.status).toBe("complete");
    expect(f.effects).toEqual(["mutation applied", "write"]);
    expect(resolved.runState?.counters.resultBytes).toBe(1026);
  });
  test("policy failures before the executor remain certain failures and do not block unrelated work", async () => {
    const f = fixture([[call("a"), call("b")]]);
    f.options.beforeTool = async (request) => {
      if (request.id === "a") throw new Error("Path denied before execution");
    };
    const run = await new AgentRuntime(f.options).run("Write", f.signal);
    expect(run.status).toBe("complete");
    expect(run.runState?.calls.a?.status).toBe("complete");
    expect(run.runState?.calls.a?.attempts).toBe(0);
    expect(f.effects).toEqual(["write"]);
  });
  test("an explicitly repeated safe read keeps the original call identity and adds a charged attempt", async () => {
    const f = fixture([[call("a", "read")]], "read");
    f.options.runLimits = { resultBytes: 100 };
    f.options.resultBytesPerCall = 32;
    f.options.afterToolEffect = async () => {
      throw new Error("Injected crash");
    };
    await expect(new AgentRuntime(f.options).run("Read", f.signal)).rejects.toThrow(
      "Injected crash",
    );
    const resumed = await new AgentRuntime(f.options).run("", f.signal, "run");
    await resolveRunUncertainty(resumed, "a", "retry", { save: () => f.store.save(resumed) });
    const done = await new AgentRuntime({ ...f.options, afterToolEffect: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(done.status).toBe("complete");
    expect(f.effects).toHaveLength(2);
    expect(done.runState?.calls.a?.attempts).toBe(2);
    expect(done.runState?.counters).toEqual({
      modelRequests: 2,
      toolCalls: 2,
      sideEffects: 0,
      resultBytes: 34,
    });
  });
  test("multiple explicitly requested retries reserve the whole batch before repeating any read", async () => {
    const f = fixture([[call("a", "read"), call("b", "read")]], "read");
    f.options.runLimits = { toolCalls: 3, resultBytes: 1000 };
    f.options.resultBytesPerCall = 32;
    f.options.afterToolEffect = async () => {
      throw new Error("Result persistence interrupted");
    };
    await expect(new AgentRuntime(f.options).run("Read", f.signal)).rejects.toThrow("interrupted");
    const run = await f.store.get();
    for (const id of ["a", "b"])
      await resolveRunUncertainty(run!, id, "retry", { save: () => f.store.save(run!) });
    f.options.afterToolEffect = undefined;
    const resumed = await new AgentRuntime(f.options).run("", f.signal, "run");
    expect(resumed.status).toBe("budget");
    expect(f.effects).toHaveLength(2);
    expect(resumed.runState?.counters.toolCalls).toBe(2);
    expect(resumed.runState?.counters.resultBytes).toBe(64);
    expect(resumed.runState?.calls.a?.retryRequested).toBe(true);
    expect(resumed.runState?.calls.b?.retryRequested).toBe(true);
  });
  test("uncertain mutations require explicit fail/abort; retry is prohibited", async () => {
    const f = fixture([[call("a")]]);
    f.options.afterToolEffect = async () => {
      throw new Error("Injected crash");
    };
    await expect(new AgentRuntime(f.options).run("Write", f.signal)).rejects.toThrow(
      "Injected crash",
    );
    const resumed = await new AgentRuntime(f.options).run("", f.signal, "run");
    await expect(
      resolveRunUncertainty(resumed, "a", "retry", { save: () => f.store.save(resumed) }),
    ).rejects.toThrow("cannot be safely repeated");
    let assigned = false;
    await resolveRunUncertainty(resumed, "a", "fail", {
      save: () => f.store.save(resumed),
      resolveEffects: async () => {
        assigned = true;
      },
    });
    const done = await new AgentRuntime({ ...f.options, afterToolEffect: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(assigned).toBe(true);
    expect(f.effects).toHaveLength(1);
    expect(
      done.messages.some(
        (message) =>
          message.role === "tool" && message.text.includes("explicitly marked unsuccessful"),
      ),
    ).toBe(true);
  });
  test("pending approval pauses durably and resumes the original batch without inference or duplicate charges", async () => {
    const f = fixture([[call("a"), call("b")]]);
    f.options.permissions = new PermissionGate("ask");
    const first = await new AgentRuntime(f.options).run("Write", f.signal);
    expect(first.status).toBe("awaiting-approval");
    expect(f.effects).toHaveLength(0);
    expect(first.runState?.pending).toEqual(["a", "b"]);
    expect(first.runState?.calls.a?.status).toBe("approval");
    expect(f.counts.requests).toBe(1);
    await resolveRunApproval(first, "a", true, () => f.store.save(first));
    const second = await new AgentRuntime(f.options).run("", f.signal, "run");
    expect(second.status).toBe("awaiting-approval");
    expect(f.effects).toHaveLength(1);
    expect(f.counts.requests).toBe(1);
    expect(second.runState?.counters.toolCalls).toBe(2);
    await resolveRunApproval(second, "b", false, () => f.store.save(second));
    const done = await new AgentRuntime(f.options).run("", f.signal, "run");
    expect(done.status).toBe("complete");
    expect(f.effects).toHaveLength(1);
    expect(
      done.messages.some(
        (message) => message.role === "tool" && message.text.includes("Approval denied"),
      ),
    ).toBe(true);
    expect(done.runState?.pending).toEqual([]);
  });
  test("an offline denial remains binding when the resumed runtime defaults to YOLO", async () => {
    const f = fixture([[call("a")]]);
    const paused = await new AgentRuntime({
      ...f.options,
      permissions: new PermissionGate("ask"),
    }).run("Write", f.signal);
    expect(paused.status).toBe("awaiting-approval");
    await resolveRunApproval(paused, "a", false, () => f.store.save(paused));
    const resumed = await new AgentRuntime({
      ...f.options,
      permissions: new PermissionGate("yolo"),
    }).run("", f.signal, "run");
    expect(resumed.status).toBe("complete");
    expect(f.effects).toHaveLength(0);
    expect(
      resumed.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "a" &&
          message.text.includes("Approval denied"),
      ),
    ).toBe(true);
    expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
  });
  test("an unresolved durable approval is still required when resume defaults to YOLO", async () => {
    const f = fixture([[call("a")]]);
    const paused = await new AgentRuntime({
      ...f.options,
      permissions: new PermissionGate("ask"),
    }).run("Write", f.signal);
    expect(paused.status).toBe("awaiting-approval");
    const resumed = await new AgentRuntime({
      ...f.options,
      permissions: new PermissionGate("yolo"),
    }).run("", f.signal, "run");
    expect(resumed.status).toBe("awaiting-approval");
    expect(resumed.runState?.calls.a?.status).toBe("approval");
    expect(f.effects).toHaveLength(0);
    expect(f.counts.requests).toBe(1);
    expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
  });
  test("fail resolution remains possible after an exhausted crash reservation and replaces its synthetic result", async () => {
    const f = fixture([[call("a")]]);
    f.options.runLimits = { resultBytes: 32 };
    f.options.afterToolEffect = async () => {
      throw new Error("Injected crash");
    };
    await expect(new AgentRuntime(f.options).run("Write", f.signal)).rejects.toThrow(
      "Injected crash",
    );
    const resumed = await new AgentRuntime(f.options).run("", f.signal, "run");
    await resolveRunUncertainty(resumed, "a", "fail", { save: () => f.store.save(resumed) });
    const done = await new AgentRuntime({ ...f.options, afterToolEffect: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(done.status).toBe("complete");
    expect(done.runState?.counters.resultBytes).toBe(32);
    expect(
      done.messages.filter((message) => message.role === "tool" && message.toolCallId === "a"),
    ).toHaveLength(1);
    expect(done.messages.find((message) => message.role === "tool")?.text).toContain(
      "explicitly marked unsuccessful",
    );
  });
  test("approved offline decisions do not authorize a changed tool contract", async () => {
    const f = fixture([[call("a")]]);
    f.options.permissions = new PermissionGate("ask");
    const first = await new AgentRuntime(f.options).run("Write", f.signal);
    await resolveRunApproval(first, "a", true, () => f.store.save(first));
    const changed = new ToolRegistry();
    changed.register({
      name: "write",
      kind: "write",
      eager: true,
      description: "Changed behavior",
      inputSchema: { type: "object" },
      execute: async () => {
        f.effects.push("changed");
        return { text: "Changed" };
      },
    });
    const done = await new AgentRuntime({
      ...f.options,
      tools: changed,
      permissions: new PermissionGate("yolo"),
    }).run("", f.signal, "run");
    expect(f.effects).toHaveLength(0);
    expect(
      done.messages.some(
        (message) => message.role === "tool" && message.text.includes("Tool contract changed"),
      ),
    ).toBe(true);
  });
  test("durable plan mode refuses side effects before their execution start", async () => {
    const f = fixture([[call("a")]]);
    f.options.mode = "plan";
    const planned = await new AgentRuntime(f.options).run("Plan", f.signal);
    expect(planned.status).toBe("failed");
    expect(f.effects).toHaveLength(0);
    expect(f.store.events.filter((event) => event.type === "tool-start")).toHaveLength(0);
    const resumed = await new AgentRuntime({ ...f.options, mode: undefined }).run(
      "",
      f.signal,
      "run",
    );
    expect(resumed.mode).toBe("plan");
    expect(f.effects).toHaveLength(0);
  });
  test("completed plans remain historical while a new human follow-up can use normal tools", async () => {
    const f = fixture([[call("new")]]);
    const prior = await f.store.create("/project", f.options.provider, "Earlier task");
    prior.mode = "build";
    prior.plan = createRunPlan(
      {
        goal: "Earlier task",
        doneWhen: "Earlier result verified",
        risks: [],
        assumptions: [],
        steps: [
          {
            id: "old",
            description: "Earlier work",
            dependencies: [],
            tools: ["write"],
            doneWhen: "Verified",
            verificationTool: "write",
          },
        ],
      },
      "build",
    );
    prior.plan.steps[0]!.status = "complete";
    await f.store.save(prior);
    const resumed = await new AgentRuntime(f.options).run("", f.signal, "run");
    expect(resumed.status).toBe("complete");
    expect(f.counts.requests).toBe(0);
    const followup = await new AgentRuntime(f.options).run(
      "Perform a new small action",
      f.signal,
      "run",
    );
    expect(followup.status).toBe("complete");
    expect(f.effects).toHaveLength(1);
    expect(followup.plan).toBeUndefined();
    expect(followup.planHistory?.[0]?.steps[0]?.id).toBe("old");
  });
  test("compound read effects pause once and a changed hook summary invalidates offline approval", async () => {
    const f = fixture([[call("a", "read")]], "read");
    f.options.permissions = new PermissionGate("ask");
    f.options.sideEffectCost = () => 1;
    let summary = "before: python3 script_a.py";
    f.options.beforeTool = async (_call, context) => {
      context.effectSummary = summary;
    };
    const pending = await new AgentRuntime(f.options).run("Read", f.signal);
    expect(pending.status).toBe("awaiting-approval");
    expect(f.effects).toHaveLength(0);
    await resolveRunApproval(pending, "a", true, () => f.store.save(pending));
    summary = "before: python3 changed_script.py";
    const rejected = await new AgentRuntime(f.options).run("", f.signal, "run");
    expect(f.effects).toHaveLength(0);
    expect(
      rejected.messages.some(
        (message) => message.role === "tool" && message.text.includes("Tool contract changed"),
      ),
    ).toBe(true);
  });
  test("external journal uncertainty preserves actual successful output and blocks later effects", async () => {
    const f = fixture([[call("a", "journal"), call("b")]]);
    f.tools.register({
      name: "journal",
      description: "journal",
      kind: "write",
      eager: true,
      inputSchema: { type: "object" },
      execute: async () => ({
        text: "File updated. Journal needs recovery.",
        outcomeUncertain: true,
      }),
    });
    const run = await new AgentRuntime(f.options).run("Write", f.signal);
    expect(run.status).toBe("uncertain");
    expect(run.runState?.calls.a?.status).toBe("uncertain");
    expect(run.runState?.calls.a?.result?.isError).toBe(false);
    expect(
      run.messages.some(
        (message) => message.role === "tool" && message.text.includes("File updated"),
      ),
    ).toBe(true);
    expect(f.effects).toHaveLength(0);
  });
  test("policy can require explicit delete approval in default YOLO mode", async () => {
    const f = fixture([[call("a")]]);
    f.options.beforeTool = async (_call, context) => {
      context.requireApproval = true;
    };
    const run = await new AgentRuntime(f.options).run("Delete", f.signal);
    expect(run.status).toBe("awaiting-approval");
    expect(f.effects).toHaveLength(0);
  });
});
