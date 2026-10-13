import { describe, expect, test } from "bun:test";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ApprovalDecision,
  type ArchitectureGraph,
  type ArchitectureService,
  type ProviderAdapter,
  type RuntimeEvent,
  type Session,
  type SessionStore,
  type ToolDefinition,
} from "../src/index.ts";

function session(id = "session", root = "/project"): Session {
  return {
    id,
    root,
    provider: "fake",
    model: "test",
    status: "running",
    mode: "build",
    createdAt: "now",
    updatedAt: "now",
    messages: [],
    usage: { input: 0, output: 0, cached: 0 },
    ledger: {
      goal: "test",
      constraints: [],
      decisions: [],
      pending: [],
      touchedPaths: [],
      verification: [],
    },
  };
}

const write: ToolDefinition = {
  name: "write",
  kind: "write",
  description: "Write a file",
  eager: true,
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute: async () => ({ text: "Written" }),
};

describe("conversation tool approval", () => {
  test("always grant survives restart, applies to later arguments, and contains no supplied secrets", async () => {
    const current = session();
    let snapshot: Session | undefined;
    let approvals = 0;
    const gate = new PermissionGate("ask", async () => {
      approvals++;
      return "always";
    });
    gate.bindSession(current, async () => {
      snapshot = structuredClone(current);
    });
    await gate.authorize(write, { path: "first", apiKey: "SECRET_NEVER_STORE" });
    await gate.authorize(write, { path: "second" });
    expect(approvals).toBe(1);
    expect(snapshot?.toolApprovals).toHaveLength(1);
    expect(snapshot?.toolApprovals?.[0]?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot?.toolApprovals)).not.toContain("SECRET_NEVER_STORE");
    const restarted = structuredClone(snapshot!);
    const restartGate = new PermissionGate("ask", async () => {
      approvals++;
      return false;
    });
    restartGate.bindSession(restarted, async () => {});
    await restartGate.authorize(write, { path: "third" });
    expect(approvals).toBe(1);
  });

  test("different session, project, tool name, kind, or schema requests approval again", async () => {
    const original = session();
    const first = new PermissionGate("ask", async () => "always");
    first.bindSession(original, async () => {});
    await first.authorize(write, { path: "first" });
    const variants: { current: Session; tool: ToolDefinition }[] = [
      { current: { ...structuredClone(original), id: "new" }, tool: write },
      { current: { ...structuredClone(original), root: "/other" }, tool: write },
      { current: structuredClone(original), tool: { ...write, name: "other" } },
      { current: structuredClone(original), tool: { ...write, kind: "execute" } },
      { current: structuredClone(original), tool: { ...write, description: "Changed contract" } },
      { current: structuredClone(original), tool: { ...write, inputSchema: { type: "object" } } },
    ];
    let approvals = 0;
    const gate = new PermissionGate("ask", async () => {
      approvals++;
      return false;
    });
    for (const { current, tool } of variants) {
      gate.bindSession(current, async () => {});
      await expect(gate.authorize(tool, { path: "next" })).rejects.toThrow("Approval denied");
    }
    expect(approvals).toBe(variants.length);
  });

  test("remembered grants cannot bypass read-only or plan policy", async () => {
    const current = session();
    const gate = new PermissionGate("ask", async () => "always");
    gate.bindSession(current, async () => {});
    await gate.authorize(write, { path: "first" });
    const readonly = new PermissionGate("read-only");
    readonly.bindSession(current, async () => {});
    await expect(readonly.authorize(write, {})).rejects.toThrow("Read-only mode denies");
    current.mode = "plan";
    await expect(gate.authorize(write, {})).rejects.toThrow("Plan mode denies");
    const yolo = new PermissionGate("yolo");
    yolo.bindSession(current, async () => {});
    await expect(yolo.authorize(write, {})).rejects.toThrow("Plan mode denies");
    await gate.authorize({ ...write, kind: "read" }, {});
  });

  test("failed persistence rolls back approval and blocks execution; another request asks again", async () => {
    const current = session();
    let approvals = 0;
    let effects = 0;
    const gate = new PermissionGate("ask", async () => {
      approvals++;
      return "always";
    });
    gate.bindSession(current, async () => {
      throw new Error("Disk failure");
    });
    const attempt = async () => {
      await gate.authorize(write, {});
      effects++;
    };
    await expect(attempt()).rejects.toThrow("Could not save approval");
    expect(current.toolApprovals).toBeUndefined();
    await expect(attempt()).rejects.toThrow("Could not save approval");
    expect(approvals).toBe(2);
    expect(effects).toBe(0);
  });

  test("concurrent requests wait until a remembered grant becomes durable", async () => {
    const current = session();
    let startSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      startSave = resolve;
    });
    let finishSave!: () => void;
    const persist = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    let approvals = 0;
    const gate = new PermissionGate("ask", async () => {
      approvals++;
      return "always";
    });
    gate.bindSession(current, async () => {
      startSave();
      await persist;
    });
    let authorized = 0;
    const first = gate.authorize(write, {}).then(() => {
      authorized++;
    });
    await saving;
    const second = gate.authorize(write, {}).then(() => {
      authorized++;
    });
    await Promise.resolve();
    expect(authorized).toBe(0);
    finishSave();
    await Promise.all([first, second]);
    expect(authorized).toBe(2);
    expect(approvals).toBe(1);
  });

  test("unbound always decisions safely reject; boolean one-shot decisions remain compatible", async () => {
    await expect(
      new PermissionGate("ask", async () => "always").authorize(write, {}),
    ).rejects.toThrow("without a bound conversation");
    await new PermissionGate("ask", async () => true).authorize(write, {});
    await expect(new PermissionGate("ask", async () => false).authorize(write, {})).rejects.toThrow(
      "Approval denied",
    );
  });

  test("rebinding while an approval is pending cannot grant or execute against another conversation", async () => {
    const original = session();
    const next = session("next");
    let answer!: (value: ApprovalDecision) => void;
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const gate = new PermissionGate("ask", async () => {
      requested();
      return new Promise<ApprovalDecision>((resolve) => {
        answer = resolve;
      });
    });
    gate.bindSession(original, async () => {});
    const authorization = gate.authorize(write, {});
    await pending;
    gate.bindSession(next, async () => {});
    answer("always");
    await expect(authorization).rejects.toThrow("Approval session changed");
    expect(original.toolApprovals).toBeUndefined();
    expect(next.toolApprovals).toBeUndefined();
  });
});

test("runtime binds refreshed durable approval state on every run before executing tools", async () => {
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
  let snapshot: Session | undefined;
  let created = 0;
  let rejectGrantSave = false;
  const events: RuntimeEvent[] = [];
  const store: SessionStore = {
    create: async () => session(String(++created)),
    get: async () => structuredClone(snapshot),
    list: async () => (snapshot ? [snapshot] : []),
    save: async (current) => {
      if (rejectGrantSave && current.toolApprovals?.length) throw new Error("Disk failure");
      snapshot = structuredClone(current);
    },
    append: async (event) => {
      events.push(event);
    },
    pendingMutations: async () => [],
    putArtifact: async () => "artifact",
    readArtifact: async () => "Written",
  };
  let requests = 0;
  const provider: ProviderAdapter = {
    id: "fake",
    model: "test",
    contextWindow: 64_000,
    async *stream(request) {
      expect(JSON.stringify(request)).not.toContain("toolApprovals");
      expect(JSON.stringify(request)).not.toContain("schemaDigest");
      if (requests++ % 2 === 0)
        yield {
          type: "tool-call",
          call: { id: String(requests), name: "write", arguments: { path: "file" } },
        };
      yield { type: "done" };
    },
  };
  let approvals = 0;
  let effects = 0;
  const tools = new ToolRegistry();
  tools.register({
    ...write,
    execute: async () => {
      expect(snapshot?.toolApprovals).toHaveLength(1);
      effects++;
      return { text: "Written" };
    },
  });
  const gate = new PermissionGate("ask", async () => {
    approvals++;
    return "always";
  });
  const options = { root: "/project", provider, tools, architecture, store, permissions: gate };
  const signal = new AbortController().signal;
  const first = await new AgentRuntime(options).run("Write", signal);
  await new AgentRuntime(options).run("Write again", signal, first.id);
  expect(approvals).toBe(1);
  await new AgentRuntime(options).run("New conversation", signal);
  expect(approvals).toBe(2);
  expect(effects).toBe(3);
  expect(events.filter((event) => event.type === "tool-start")).toHaveLength(3);
  rejectGrantSave = true;
  const denied = await new AgentRuntime(options).run("Cannot persist approval", signal);
  expect(approvals).toBe(3);
  expect(effects).toBe(3);
  expect(denied.toolApprovals).toBeUndefined();
  expect(denied.messages.find((message) => message.role === "tool")?.text).toContain(
    "Could not save approval",
  );
  expect(events.filter((event) => event.type === "tool-start")).toHaveLength(3);
});
