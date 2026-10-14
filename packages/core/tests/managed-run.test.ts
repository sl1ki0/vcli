import { describe, expect, test } from "bun:test";
import {
  ManagedRuntime,
  ToolRegistry,
  boundRunResult,
  taskChecklist,
  type ManagedExecutor,
  type ManagedJournal,
  type ManagedRun,
  type ManagedRuntimeOptions,
  type ManagedStore,
  type ModelRequest,
  type ProviderAdapter,
  type RunFile,
  type RunLimits,
  type RunPlan,
  type RunResult,
  type RunTree,
  type ToolCall,
} from "../src/index.ts";

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  arguments: args,
});
const read = (id = "read"): ToolCall => call(id, "read_file", { path: "order.py" });
const write = (id = "write"): ToolCall =>
  call(id, "write_file", { path: "order.py", content: "fixed" });
const bash = (id = "bash"): ToolCall => call(id, "Bash", { command: "tests", cwd: "." });
const file = (content: string): RunFile => ({ content, hash: content, mode: 0o644 });
const identity = (tree: RunTree) =>
  JSON.stringify(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));
class Store implements ManagedStore {
  saved?: ManagedRun;
  snapshots: ManagedRun[] = [];
  async save(run: ManagedRun) {
    if (this.saved && this.saved.revision !== run.revision) throw new Error("Stale revision");
    run.revision++;
    this.saved = structuredClone(run);
    this.snapshots.push(structuredClone(run));
  }
  async get(id: string) {
    if (!this.saved || this.saved.id !== id) throw new Error("Unknown run");
    return structuredClone(this.saved);
  }
}
class Executor implements ManagedExecutor {
  tree: RunTree = { "order.py": file("broken"), "test_order.py": file("unchanged tests") };
  executions: string[] = [];
  beforeExecute?: (call: ToolCall) => void;
  schemas = [
    {
      name: "read_file",
      description: "Read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    {
      name: "write_file",
      description: "Write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
    {
      name: "delete_file",
      description: "Delete",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    {
      name: "Bash",
      description: "Tests",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command", "cwd"],
        properties: { command: { type: "string" }, cwd: { type: "string" } },
      },
    },
  ];
  registry = new ToolRegistry();
  constructor() {
    for (const schema of this.schemas)
      this.registry.register({ ...schema, kind: "read", execute: async () => ({ text: "" }) });
  }
  kind(name: string) {
    return name === "read_file"
      ? ("read" as const)
      : name === "write_file"
        ? ("write" as const)
        : name === "delete_file"
          ? ("delete" as const)
          : name === "Bash"
            ? ("bash" as const)
            : ("control" as const);
  }
  validate(value: ToolCall) {
    this.registry.validate(value);
  }
  async check(value: ToolCall) {
    this.validate(value);
    if (value.arguments.path === "denied") throw new Error("Policy denied path");
  }
  async execute(value: ToolCall, _resultBytes: number, _signal: AbortSignal): Promise<RunResult> {
    this.beforeExecute?.(value);
    this.executions.push(value.id);
    const path = value.arguments.path as string;
    if (value.name === "read_file") {
      if (!this.tree[path]) throw new Error("Missing file");
      return { text: this.tree[path]!.content };
    }
    if (value.name === "write_file") {
      this.tree[path] = file(value.arguments.content as string);
      return { text: "Wrote file" };
    }
    if (value.name === "delete_file") {
      delete this.tree[path];
      return { text: "Deleted file" };
    }
    return { text: "Tests OK", exitCode: 0 };
  }
}
class Journal implements ManagedJournal {
  constructor(readonly executor: Executor) {}
  async capture() {
    return structuredClone(this.executor.tree);
  }
  async before(run: ManagedRun) {
    if (identity(run.journal.expected) !== identity(this.executor.tree))
      throw new Error("Project conflict");
    run.journal.expected = await this.capture();
  }
  async after(run: ManagedRun) {
    run.journal.expected = await this.capture();
    run.journal.changes = [
      ...new Set([...Object.keys(run.journal.initial), ...Object.keys(this.executor.tree)]),
    ]
      .filter((path) => run.journal.initial[path]?.hash !== this.executor.tree[path]?.hash)
      .map((path) => ({
        path,
        before: run.journal.initial[path],
        after: this.executor.tree[path],
      }));
  }
  async inspect(run: ManagedRun) {
    return `${identity(run.journal.expected)} -> ${identity(this.executor.tree)}`;
  }
  async rollback(_run: ManagedRun) {
    throw new Error("Rollback separately tested against real journal");
  }
}
type Turn = ToolCall[] | string;
class Provider implements ProviderAdapter {
  id = "deterministic";
  model = "offline";
  contextWindow = 32_768;
  requests: ModelRequest[] = [];
  usage?: { input: number; output: number; cached: number };
  constructor(readonly turns: Turn[]) {}
  async *stream(request: ModelRequest) {
    this.requests.push(structuredClone(request));
    const turn = this.turns.shift() ?? "Done";
    if (typeof turn === "string") yield { type: "text" as const, text: turn };
    else for (const value of turn) yield { type: "tool-call" as const, call: value };
    if (this.usage) yield { type: "usage" as const, usage: this.usage };
    yield { type: "done" as const };
  }
}
async function setup(
  turns: Turn[],
  options: {
    mode?: "auto" | "safe";
    plan?: boolean;
    limits?: Partial<RunLimits>;
    fault?: ManagedRuntimeOptions["fault"];
  } = {},
) {
  const executor = new Executor();
  const store = new Store();
  const journal = new Journal(executor);
  const provider = new Provider(turns);
  const dependencies = { executor, store, journal, provider };
  const runtime = new ManagedRuntime({ ...dependencies, fault: options.fault });
  const run = await runtime.create({
    id: "run",
    root: "/workspace",
    policyPath: "/policy.json",
    goal: "Fix order without changing tests",
    mode: options.mode ?? "auto",
    plan: options.plan,
    limits: options.limits,
  });
  return { ...dependencies, runtime, run, restart: () => new ManagedRuntime(dependencies) };
}
const signal = () => new AbortController().signal;
function plan(): RunPlan {
  return {
    goal: "Fix and verify",
    risks: ["Preserve tests"],
    assumptions: ["Python available"],
    doneWhen: "Tests pass",
    steps: [
      {
        id: "inspect",
        description: "Inspect source",
        dependsOn: [],
        tools: ["read_file"],
        outcome: { tool: "read_file", contains: "broken" },
        state: "pending",
      },
      {
        id: "implement",
        description: "Fix source",
        dependsOn: ["inspect"],
        tools: ["write_file"],
        outcome: { tool: "write_file", contains: "Wrote" },
        state: "pending",
      },
      {
        id: "verify",
        description: "Run tests",
        dependsOn: ["implement"],
        tools: ["Bash"],
        outcome: { tool: "Bash", exitCode: 0 },
        state: "pending",
      },
    ],
  };
}
function submit(value = plan(), id = "plan") {
  const args = { ...value, steps: value.steps.map(({ state: _state, ...task }) => task) };
  return call(id, "submit_plan", args);
}
const complete = (id: string, evidence: string) =>
  call(id, "complete_task", { evidence_call_id: evidence });

describe("managed agent loop and durable approvals", () => {
  test("multiple tool calls, strict schema rejection, recoverable tool errors and tool IDs", async () => {
    const state = await setup([
      [
        call("unknown", "unavailable"),
        call("bad", "write_file", { path: "order.py", content: 1 }),
        call("missing", "read_file", { path: "missing" }),
      ],
      [write(), bash()],
      "Fixed and verified",
    ]);
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("complete");
    expect(state.executor.executions).toEqual(["missing", "write", "bash"]);
    expect(state.executor.tree["test_order.py"]!.content).toBe("unchanged tests");
    expect(
      state.run.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["unknown", "bad", "missing", "write", "bash"]);
    expect(state.run.calls.slice(0, 3).every((value) => value.result?.isError)).toBe(true);
    expect(
      state.provider.requests[1]!.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "missing",
      ),
    ).toBe(true);
  });

  test("completed IDs are cached; changed identity produces protocol error without mutation", async () => {
    const state = await setup([
      [write()],
      [write()],
      [call("write", "delete_file", { path: "order.py" })],
      "Done",
    ]);
    await state.runtime.advance(state.run, signal());
    expect(state.executor.executions).toEqual(["write"]);
    expect(state.run.calls).toHaveLength(1);
    expect(state.executor.tree["order.py"]!.content).toBe("fixed");
    expect(state.run.messages.filter((message) => message.role === "tool").at(-1)!.text).toContain(
      "Protocol error",
    );
  });

  test("safe approval persists before effect and resumes the exact pending action", async () => {
    const state = await setup([[write()], "Done"], { mode: "safe" });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-approval");
    expect(state.executor.executions).toEqual([]);
    const resumed = await state.store.get("run");
    const runtime = state.restart();
    await runtime.approveAction(resumed, "allow");
    state.executor.beforeExecute = () =>
      expect(state.store.saved!.calls[0]!.approval).toBe("allow");
    await runtime.advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(state.executor.executions).toEqual(["write"]);
    expect(resumed.calls[0]!.decisions[0]!.action).toBe("allow");
  });

  test("decline is durable and returned to model as a tool result", async () => {
    const state = await setup([[write()], "I will stop"], { mode: "safe" });
    await state.runtime.advance(state.run, signal());
    await state.runtime.approveAction(state.run, "deny");
    const resumed = await state.store.get("run");
    await state.restart().advance(resumed, signal());
    expect(state.executor.executions).toEqual([]);
    expect(resumed.calls[0]!.result?.text).toContain("declined");
    expect(state.provider.requests[1]!.messages.at(-1)!.toolCallId).toBe("write");
    expect(resumed.calls[0]!.decisions[0]!.action).toBe("deny");
  });

  test("auto mode always stops for explicit deletion approval", async () => {
    const state = await setup([[call("delete", "delete_file", { path: "order.py" })], "Done"]);
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-approval");
    expect(state.executor.tree["order.py"]).toBeDefined();
    await state.runtime.approveAction(state.run, "allow");
    await state.runtime.advance(state.run, signal());
    expect(state.executor.tree["order.py"]).toBeUndefined();
  });
});

describe("managed plans and verified dependent tasks", () => {
  test("planning saves structure and blocks writes and Bash before explicit approval", async () => {
    const state = await setup([[write(), bash(), read(), submit()]], { plan: true, mode: "safe" });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-plan");
    expect(state.executor.executions).toEqual(["read"]);
    expect(state.run.calls.slice(0, 2).every((value) => value.result?.isError)).toBe(true);
    expect(state.run.plan).toMatchObject({
      goal: "Fix and verify",
      risks: ["Preserve tests"],
      doneWhen: "Tests pass",
    });
    expect(state.run.calls.every((value) => !value.taskId && value.phase === "planning")).toBe(
      true,
    );
    expect((await state.store.get("run")).plan!.steps).toHaveLength(3);
    await state.runtime.approvePlan(state.run, "reject");
    expect(state.run.status).toBe("rejected");
    await state.runtime.advance(state.run, signal());
    expect(state.executor.executions).toEqual(["read"]);
  });

  test("three dependency tasks use recorded evidence and survive approval/resume without replay", async () => {
    const state = await setup(
      [
        [submit()],
        [write("too-early"), read("source")],
        [complete("spoof", "too-early"), complete("inspection-done", "source")],
        [write("fix")],
        [complete("fix-done", "fix")],
        [bash("tests")],
        [complete("tests-done", "tests")],
        "Done",
      ],
      { plan: true, mode: "safe" },
    );
    await state.runtime.advance(state.run, signal());
    await state.runtime.approvePlan(state.run, "approve");
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-approval");
    expect(state.run.plan!.steps[0]!.state).toBe("complete");
    expect(state.run.calls.find((entry) => entry.call.id === "spoof")!.result?.isError).toBe(true);
    expect(state.executor.executions).toEqual(["source"]);
    let resumed = await state.store.get("run");
    const spent = { ...resumed.spent };
    await state.restart().approveAction(resumed, "allow");
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("waiting-approval");
    expect(resumed.spent.toolCalls).toBeGreaterThan(spent.toolCalls);
    resumed = await state.store.get("run");
    await state.restart().approveAction(resumed, "allow");
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(state.executor.executions).toEqual(["source", "fix", "tests"]);
    expect(resumed.plan!.steps.every((task) => task.state === "complete" && task.evidence)).toBe(
      true,
    );
    expect(
      taskChecklist(resumed)
        .split("\n")
        .every((line) => line.startsWith("[x]")),
    ).toBe(true);
    expect(resumed.calls.find((entry) => entry.call.id === "fix")!.taskId).toBe("implement");
    expect(resumed.calls.find((entry) => entry.call.id === "tests")!.taskId).toBe("verify");
  });

  test("cycles and unverified final answers cannot complete a task plan", async () => {
    const cyclic = plan();
    cyclic.steps[0]!.dependsOn = ["verify"];
    const state = await setup([[submit(cyclic, "cycle"), submit()], "Claims all complete"], {
      plan: true,
    });
    await state.runtime.advance(state.run, signal());
    expect(state.run.calls[0]!.result?.text).toContain("cycle");
    expect(state.run.status).toBe("waiting-plan");
    await state.runtime.approvePlan(state.run, "approve");
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("failed");
    expect(state.run.error).toContain("unverified");
    expect(state.executor.executions).toEqual([]);
  });
});

describe("managed atomic budgets and crashes", () => {
  test("model request limit prevents inference and persists across resume", async () => {
    const state = await setup([[read()]], { limits: { modelRequests: 0 } });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("budget");
    expect(state.run.error).toContain("modelRequests");
    expect(state.provider.requests).toHaveLength(0);
    const resumed = await state.store.get("run");
    await state.restart().advance(resumed, signal());
    expect(resumed.spent).toEqual(state.run.spent);
  });

  test("tool-call budget reserves whole batch; no prefix runs", async () => {
    const state = await setup([[read("a"), read("b")]], { limits: { toolCalls: 1 } });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("budget");
    expect(state.run.error).toContain("toolCalls");
    expect(state.executor.executions).toEqual([]);
    expect(state.run.spent.toolCalls).toBe(0);
  });

  test("side-effect budget rejects whole mixed batch atomically", async () => {
    const state = await setup([[read(), write("a"), write("b")]], { limits: { sideEffects: 1 } });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("budget");
    expect(state.run.error).toContain("sideEffects");
    expect(state.executor.executions).toEqual([]);
    expect(state.run.spent.toolCalls).toBe(0);
    expect(state.run.spent.sideEffects).toBe(0);
  });

  test("result-byte budget clips unknown output and prevents the next effect", async () => {
    const state = await setup([[read(), write()]], { limits: { resultBytes: 3 } });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("budget");
    expect(state.run.error).toContain("resultBytes");
    expect(state.executor.executions).toEqual(["read"]);
    expect(state.run.spent.resultBytes).toBe(3);
    expect(state.run.calls[0]!.result).toMatchObject({ text: "[in", truncated: true });
    expect(state.run.messages.at(-1)!.text).toBe("[in");
    expect((await state.store.get("run")).spent).toEqual(state.run.spent);
  });

  test("crash after atomic charge resumes pending call without refund or double charge", async () => {
    let crash = true;
    const state = await setup([[write()], "Done"], {
      fault: (point) => {
        if (point === "after-budget" && crash) {
          crash = false;
          throw new Error("Injected crash");
        }
      },
    });
    await expect(state.runtime.advance(state.run, signal())).rejects.toThrow("Injected crash");
    expect(state.executor.executions).toEqual([]);
    const resumed = await state.store.get("run");
    expect(resumed.spent).toMatchObject({ modelRequests: 1, toolCalls: 1, sideEffects: 1 });
    expect(resumed.calls[0]!.state).toBe("pending");
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(resumed.spent).toMatchObject({ modelRequests: 2, toolCalls: 1, sideEffects: 1 });
    expect(state.executor.executions).toEqual(["write"]);
  });

  test("crash after effect is uncertain, never replayed, and requires explicit change adoption", async () => {
    const state = await setup([[write()], "Done"], {
      fault: (point) => {
        if (point === "after-effect") throw new Error("Crash after edit");
      },
    });
    await expect(state.runtime.advance(state.run, signal())).rejects.toThrow("Crash after edit");
    expect(state.executor.tree["order.py"]!.content).toBe("fixed");
    const resumed = await state.store.get("run");
    const runtime = state.restart();
    await runtime.advance(resumed, signal());
    expect(resumed.status).toBe("uncertain");
    expect(state.executor.executions).toEqual(["write"]);
    await expect(runtime.resolve(resumed, "write", "retry")).rejects.toThrow("read");
    await expect(runtime.resolve(resumed, "write", "fail")).rejects.toThrow("adopt");
    expect(await state.journal.inspect(resumed)).toContain("fixed");
    await runtime.resolve(resumed, "write", "fail", true);
    expect(resumed.journal.changes.map((change) => change.path)).toEqual(["order.py"]);
    await runtime.advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(state.executor.executions).toEqual(["write"]);
    expect(resumed.spent.sideEffects).toBe(1);
    expect(resumed.calls[0]!.decisions[0]!.action).toBe("fail-and-adopt");
  });

  test("explicit uncertain read retry is a charged new attempt of the same tool call", async () => {
    const state = await setup([[read()], "Done"], {
      fault: (point) => {
        if (point === "after-start") throw new Error("Crash before read");
      },
    });
    await expect(state.runtime.advance(state.run, signal())).rejects.toThrow();
    const resumed = await state.store.get("run");
    const runtime = state.restart();
    await runtime.advance(resumed, signal());
    await runtime.resolve(resumed, "read", "retry");
    await runtime.advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(resumed.calls[0]!.attempts).toBe(2);
    expect(resumed.spent.toolCalls).toBe(2);
    expect(state.executor.executions).toEqual(["read"]);
  });

  test("crash after model charge conservatively retains the spent request", async () => {
    const state = await setup(["Done"], {
      limits: { modelRequests: 1 },
      fault: (point) => {
        if (point === "after-model-budget") throw new Error("Crash before inference");
      },
    });
    await expect(state.runtime.advance(state.run, signal())).rejects.toThrow();
    const resumed = await state.store.get("run");
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("budget");
    expect(resumed.spent.modelRequests).toBe(1);
    expect(resumed.tokenBudget!.spent).toBeGreaterThan(4096);
    expect(resumed.tokenBudget!.spent).toBe(state.run.tokenBudget!.spent);
    expect(state.provider.requests).toHaveLength(0);
  });

  test("UTF-8 truncation never exceeds the byte budget", () => {
    const result = boundRunResult({ text: "🙂".repeat(6) }, 17);
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(17);
    expect(result).toMatchObject({ text: "[incomplete] 🙂", truncated: true });
  });
});

describe("managed persisted schema guard and token reservations", () => {
  const invalidWrite = (id: string) => call(id, "write_file", { path: "order.py", content: 1 });

  test("three schema failures stop and remain blocked across an empty resume", async () => {
    const state = await setup([
      [invalidWrite("bad1"), invalidWrite("bad2"), invalidWrite("bad3"), write()],
      "Done",
    ]);
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("failed");
    expect(state.run.schemaErrors).toEqual([{ tool: "write_file", count: 3 }]);
    expect(state.executor.executions).toEqual([]);
    const resumed = await state.store.get("run");
    const requests = state.provider.requests.length;
    await state.restart().resumeFailure(resumed);
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("failed");
    expect(resumed.schemaErrors![0]!.count).toBe(3);
    expect(state.provider.requests).toHaveLength(requests);
    expect(state.executor.executions).toEqual([]);
  });

  test("corrected arguments clear that tool's persisted failure count", async () => {
    const state = await setup([[invalidWrite("bad1"), invalidWrite("bad2"), write()], "Done"], {
      mode: "safe",
    });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-approval");
    expect(state.run.schemaErrors).toEqual([]);
    const resumed = await state.store.get("run");
    expect(resumed.schemaErrors).toEqual([]);
    await state.restart().approveAction(resumed, "allow");
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(state.executor.executions).toEqual(["write"]);
  });

  test("effects proposed after submit_plan in the same batch cannot cross approval", async () => {
    const state = await setup([[submit(), write(), bash()], "Done"], { plan: true });
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("waiting-plan");
    expect(state.executor.executions).toEqual([]);
    const resumed = await state.store.get("run");
    await state.restart().approvePlan(resumed, "approve");
    await state.restart().advance(resumed, signal());
    expect(state.executor.executions).toEqual([]);
    expect(
      resumed.calls
        .filter((entry) => ["write", "bash"].includes(entry.call.id))
        .every(
          (entry) => entry.result?.isError && entry.result.text.includes("carried across approval"),
        ),
    ).toBe(true);
    expect(state.executor.tree["order.py"]!.content).toBe("broken");
  });

  test("measured token usage settles once and remains settled across crash/resume", async () => {
    const state = await setup([[read()], "Done"], {
      fault: (point) => {
        if (point === "after-budget") throw new Error("Crash after settlement");
      },
    });
    state.provider.usage = { input: 10, output: 4, cached: 2 };
    await expect(state.runtime.advance(state.run, signal())).rejects.toThrow();
    const resumed = await state.store.get("run");
    expect(resumed.tokenBudget!.spent).toBe(14);
    await state.restart().advance(resumed, signal());
    expect(resumed.status).toBe("complete");
    expect(resumed.tokenBudget!.spent).toBe(28);
    const spent = resumed.tokenBudget!.spent;
    await state.restart().advance(resumed, signal());
    expect(resumed.tokenBudget!.spent).toBe(spent);
    expect(state.executor.executions).toEqual(["read"]);
  });

  test("token and context limits stop inference before a request starts", async () => {
    const state = await setup(["Done"]);
    state.run.tokenBudget!.limit = 1;
    await state.store.save(state.run);
    await state.runtime.advance(state.run, signal());
    expect(state.run.status).toBe("budget");
    expect(state.run.tokenBudget!.spent).toBe(0);
    expect(state.provider.requests).toHaveLength(0);
    const limited = await setup(["Done"]);
    limited.provider.contextWindow = 100;
    await limited.runtime.advance(limited.run, signal());
    expect(limited.run.status).toBe("budget");
    expect(limited.provider.requests).toHaveLength(0);
  });
});
