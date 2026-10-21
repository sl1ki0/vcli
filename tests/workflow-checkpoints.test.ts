import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type PermissionMode,
  type ProviderAdapter,
  type RuntimeEvent,
  type ToolCall,
  type ToolDefinition,
} from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { fileTools } from "../apps/cli/src/tools/files.ts";
import { CheckpointService } from "../apps/cli/src/workflows/checkpoints.ts";
import { createLocalWorkflows } from "../apps/cli/src/workflows/runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface FixtureOptions {
  permission?: PermissionMode;
  approve?: ConstructorParameters<typeof PermissionGate>[1];
  hooks?: Record<string, unknown>;
  decorate?: (tool: ToolDefinition) => ToolDefinition;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "vcli-workflow-checkpoints-"));
  await mkdir(join(root, ".vcli"));
  await writeFile(join(root, "source.ts"), "export const value = 1;\n");
  if (options.hooks)
    await writeFile(
      join(root, ".vcli/hooks.json"),
      JSON.stringify({ version: 1, ...options.hooks }),
    );
  const store = await SqliteSessionStore.open(root);
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const queue: ToolCall[][] = [];
  const provider: ProviderAdapter = {
    id: "fixture",
    model: "fixture",
    contextWindow: 32_000,
    async *stream() {
      const calls = queue.shift() ?? [];
      for (const call of calls) yield { type: "tool-call", call };
      if (!calls.length) yield { type: "text", text: "Done." };
      yield { type: "usage", usage: { input: 50, output: 10, cached: 0 } };
      yield { type: "done" };
    },
  };
  const registry = new ToolRegistry();
  fileTools.forEach((tool) =>
    registry.register({ ...(options.decorate?.(tool) ?? tool), eager: true }),
  );
  const permissions = new PermissionGate(options.permission ?? "yolo", options.approve);
  const architecture = createArchitectureService();
  const events: RuntimeEvent[] = [];
  const workflows = await createLocalWorkflows({
    root,
    registry,
    provider,
    store,
    architecture,
    permissions,
    runtime: () => runtime,
  });
  const runtime = new AgentRuntime({
    root,
    provider,
    store,
    architecture,
    permissions,
    tools: registry,
    beforeTool: workflows.beforeTool,
    executeTool: workflows.executeTool,
    settings: { maxTurns: 3 },
    onEvent: (event) => {
      events.push(event);
    },
  });
  return {
    root,
    store,
    events,
    registry,
    checkpoints: new CheckpointService(root),
    async run(calls: ToolCall[], resume?: string) {
      queue.push(calls, []);
      return runtime.run("Apply the requested file edit.", new AbortController().signal, resume);
    },
  };
}

function patch(path = "source.ts"): ToolCall {
  return {
    id: crypto.randomUUID(),
    name: "files_patch",
    arguments: { path, oldText: "value = 1", newText: "value = 2" },
  };
}
const beforeMarker = {
  beforeTool: [{ name: "marker", tools: ["files_patch"], command: "printf before >> hook.log" }],
};

describe("checkpoint execution boundary", () => {
  test("validates tool arguments before hooks or checkpoint capture", async () => {
    const approvals: string[] = [];
    const f = await fixture({
      hooks: beforeMarker,
      permission: "ask",
      approve: async (tool) => {
        approvals.push(tool.name);
        return true;
      },
    });
    const call = { ...patch(), arguments: { path: "source.ts", newText: 42 } };
    const session = await f.run([call]);
    expect(session.messages.find((message) => message.role === "tool")!.text).toContain(
      "Invalid arguments",
    );
    expect(await Bun.file(join(f.root, "hook.log")).exists()).toBe(false);
    expect(await f.checkpoints.list()).toEqual([]);
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 1");
    expect(await f.store.pendingMutations(session.id)).toEqual([]);
    expect(approvals).toEqual([]);
    expect(f.events.filter((event) => event.type === "tool-start")).toEqual([]);
  });

  test("read-only and declined approval never run hooks or create checkpoints", async () => {
    for (const permission of ["read-only", "ask"] as const) {
      const decisions: string[] = [];
      const f = await fixture({
        permission,
        hooks: beforeMarker,
        approve: async (tool) => {
          decisions.push(tool.name);
          return false;
        },
      });
      const session = await f.run([patch()]);
      expect(session.messages.find((message) => message.role === "tool")!.text).toContain(
        permission === "ask" ? "Approval denied" : "Read-only mode denies",
      );
      expect(await Bun.file(join(f.root, "hook.log")).exists()).toBe(false);
      expect(await f.checkpoints.list()).toEqual([]);
      expect(f.events.filter((event) => event.type === "tool-start")).toEqual([]);
      expect(decisions).toEqual(permission === "ask" ? ["files_patch"] : []);
    }
  });

  test("authorizes the file edit before authorizing its hooks and capturing files", async () => {
    const approvals: string[] = [];
    const f = await fixture({
      permission: "ask",
      hooks: beforeMarker,
      approve: async (tool) => {
        approvals.push(tool.name);
        return true;
      },
    });
    const session = await f.run([patch()]);
    expect(approvals).toEqual(["files_patch", "hook.beforeTool.marker"]);
    expect(await readFile(join(f.root, "hook.log"), "utf8")).toBe("before");
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 2");
    expect(await f.checkpoints.list(session.id)).toHaveLength(1);
    expect((await f.checkpoints.list())[0]!.status).toBe("ready");
    expect(await f.store.pendingMutations(session.id)).toEqual([]);
  });

  test("before-hook rejection leaves source and checkpoint state untouched", async () => {
    const f = await fixture({
      hooks: {
        beforeTool: [{ name: "guard", tools: ["files_patch"], command: "printf blocked; exit 9" }],
      },
    });
    const session = await f.run([patch()]);
    expect(session.messages.find((message) => message.role === "tool")!.text).toContain(
      "blocked the tool",
    );
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 1");
    expect(await f.checkpoints.list()).toEqual([]);
  });

  test("after-hook failure retains the successful mutation, durable artifact and ready checkpoint", async () => {
    const f = await fixture({
      hooks: {
        afterTool: [
          { name: "verify", tools: ["files_patch"], command: "printf verification-failed; exit 5" },
        ],
      },
    });
    const session = await f.run([patch()]);
    const end = f.events.find((event) => event.type === "tool-end")!;
    expect(end.data.isError).toBe(false);
    expect(end.data.changedPaths).toEqual(["source.ts"]);
    expect(session.ledger.touchedPaths).toEqual(["source.ts"]);
    expect(await f.store.readArtifact(String(end.data.artifact))).toContain(
      "Tool outcome is unchanged",
    );
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 2");
    const checkpoint = (await f.checkpoints.list(session.id))[0]!;
    expect(checkpoint.status).toBe("ready");
    const resumed = await f.run(
      [{ id: crypto.randomUUID(), name: "checkpoint_restore", arguments: { id: checkpoint.id } }],
      session.id,
    );
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 1");
    expect((await f.store.get(resumed.id))!.messages.at(-2)!.text).toContain("Restored source.ts");
    expect(await f.store.pendingMutations(session.id)).toEqual([]);
  });

  test("post-hook external edits cannot be overwritten by a later rewind", async () => {
    const f = await fixture({
      hooks: {
        afterTool: [
          {
            name: "formatter",
            tools: ["files_patch"],
            command: "printf 'external formatting' > source.ts",
          },
        ],
      },
    });
    const session = await f.run([patch()]);
    const checkpoint = (await f.checkpoints.list(session.id))[0]!;
    const resumed = await f.run(
      [{ id: crypto.randomUUID(), name: "checkpoint_restore", arguments: { id: checkpoint.id } }],
      session.id,
    );
    expect(resumed.messages.filter((message) => message.role === "tool").at(-1)!.text).toContain(
      "preserve external edits",
    );
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toBe("external formatting");
    expect((await f.checkpoints.list())[0]!.status).toBe("ready");
  });

  test("checkpoint bookkeeping failure cannot disguise a completed real file patch", async () => {
    const f = await fixture({
      decorate: (tool) =>
        tool.name !== "files_patch"
          ? tool
          : {
              ...tool,
              async execute(args, context) {
                const result = await tool.execute(args, context);
                await rm(join(context.root, ".vcli/state/checkpoints"), {
                  recursive: true,
                  force: true,
                });
                return result;
              },
            },
    });
    const session = await f.run([patch()]);
    const end = f.events.find((event) => event.type === "tool-end")!;
    expect(end.data.isError).toBe(false);
    expect(session.messages.find((message) => message.role === "tool")!.text).toContain(
      "Do not replay the edit",
    );
    expect(await readFile(join(f.root, "source.ts"), "utf8")).toContain("value = 2");
    expect(await f.store.pendingMutations(session.id)).toEqual([]);
  });

  test("checkpointed native file tools deliberately reject symbolic links and out-of-project edits", async () => {
    const f = await fixture();
    const other = await fixture();
    await symlink(join(other.root, "source.ts"), join(f.root, "link.ts"));
    const session = await f.run([patch("link.ts"), patch(join(other.root, "source.ts"))]);
    const results = session.messages.filter((message) => message.role === "tool");
    expect(results[0]!.text).toContain("symbolic link");
    expect(results[1]!.text).toContain("inside the project");
    expect(await readFile(join(other.root, "source.ts"), "utf8")).toContain("value = 1");
    expect(await f.checkpoints.list()).toEqual([]);
  });
});
