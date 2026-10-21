import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ProviderAdapter,
  type ToolCall,
  type ToolContext,
} from "@vcli/core";
import { createArchitectureService } from "@vcli/architecture";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { fileTools } from "../apps/cli/src/tools/files.ts";
import { createLocalWorkflows } from "../apps/cli/src/workflows/runtime.ts";
import { resolveTool } from "../apps/cli/src/workflows/run-controls.ts";
import { shellTool } from "../apps/cli/src/tools/shell.ts";
import { ProjectPolicy } from "../apps/cli/src/workflows/policy.ts";
import { RunJournal } from "../apps/cli/src/workflows/journal.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const original =
  "def calculate_total(prices, discount_percent):\n    return sum(prices) - discount_percent\n";
const fixed =
  "def calculate_total(prices, discount_percent):\n    return sum(prices) * (1 - discount_percent / 100)\n";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-journal-")));
  directories.push(directory);
  const root = join(directory, "project");
  const stateDirectory = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "order.py"), original);
  await chmod(join(root, "order.py"), 0o750);
  await writeFile(join(root, "test_order.py"), "# immutable project tests\n");
  const context: ToolContext = { root, sessionId: "run-one", signal: new AbortController().signal };
  const journal = new RunJournal(root, { stateDirectory });
  return {
    directory,
    root,
    stateDirectory,
    context,
    journal,
    restart: () => new RunJournal(root, { stateDirectory }),
  };
}
const call = (id: string): ToolCall => ({
  id,
  name: "files_patch",
  arguments: { path: "order.py", overwrite: true, newText: fixed },
});

describe("run journal", () => {
  test("tracks native edits, creations and deletions and restores bytes/modes after restart", async () => {
    const { root, context, journal, restart } = await fixture();
    const token = await journal.before(call("edit"), context);
    await writeFile(join(root, "order.py"), fixed);
    await chmod(join(root, "order.py"), 0o644);
    await writeFile(join(root, "created.txt"), "new file\n");
    await unlink(join(root, "test_order.py"));
    await journal.after(token);
    const resumed = restart();
    const summary = await resumed.inspect(context.sessionId);
    expect(summary.paths).toEqual(["created.txt", "order.py", "test_order.py"]);
    expect(summary.diff).toContain("discount_percent / 100");
    expect(summary.diff).toContain("/dev/null");
    await resumed.rollback(context.sessionId);
    expect(await readFile(join(root, "order.py"), "utf8")).toBe(original);
    expect((await stat(join(root, "order.py"))).mode & 0o777).toBe(0o750);
    expect(await readFile(join(root, "test_order.py"), "utf8")).toBe("# immutable project tests\n");
    await expect(stat(join(root, "created.txt"))).rejects.toThrow();
    expect((await resumed.rollback(context.sessionId)).rolledBack).toBe(true);
  });
  test("prototype-shaped filenames retain original state across serialized snapshots", async () => {
    const { root, context, journal, restart } = await fixture();
    await writeFile(join(root, "constructor"), "original constructor file");
    const token = await journal.before(call("prototype-names"), context);
    await writeFile(join(root, "constructor"), "changed constructor file");
    await writeFile(join(root, "__proto__"), "created proto file");
    await journal.after(token);
    const resumed = restart();
    expect((await resumed.inspect(context.sessionId)).paths).toEqual(["__proto__", "constructor"]);
    await resumed.rollback(context.sessionId);
    expect(await readFile(join(root, "constructor"), "utf8")).toBe("original constructor file");
    await expect(stat(join(root, "__proto__"))).rejects.toThrow();
  });
  test("external edits stop the next mutation and make rollback all-or-none", async () => {
    const { root, context, journal } = await fixture();
    const token = await journal.before(call("edit"), context);
    await writeFile(join(root, "order.py"), fixed);
    await writeFile(join(root, "new.txt"), "agent output");
    await journal.after(token);
    await writeFile(join(root, "order.py"), "external edit\n");
    await expect(journal.before(call("second"), context)).rejects.toThrow("outside");
    await expect(journal.rollback(context.sessionId)).rejects.toThrow("conflict");
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("external edit\n");
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("agent output");
  });
  test("crash between effect and recording remains pending until explicit attribution", async () => {
    const { root, context, journal, restart } = await fixture();
    await journal.before(call("uncertain-edit"), context);
    // Controlled failure point: effects happened, journal.after was never called.
    await writeFile(join(root, "order.py"), fixed);
    const resumed = restart();
    expect(await resumed.inspectUncertain(context.sessionId, "uncertain-edit")).toContain(
      "discount_percent / 100",
    );
    await expect(resumed.rollback(context.sessionId)).rejects.toThrow("uncertain");
    await expect(resumed.before(call("other"), context)).rejects.toThrow("uncertain");
    await resumed.resolvePending(context.sessionId, "uncertain-edit", true);
    await resumed.rollback(context.sessionId);
    expect(await readFile(join(root, "order.py"), "utf8")).toBe(original);
  });
  test("a crash after journal finalization still requires explicit effect attribution on recovery", async () => {
    const { root, stateDirectory } = await fixture();
    const store = await SqliteSessionStore.open(root, { directory: stateDirectory });
    const registry = new ToolRegistry();
    fileTools.forEach((tool) => registry.register({ ...tool, eager: true }));
    let requests = 0;
    const provider: ProviderAdapter = {
      id: "journal-fixture",
      model: "journal-fixture",
      contextWindow: 32_768,
      async *stream() {
        requests++;
        if (requests === 1) yield { type: "tool-call", call: call("crash-after-journal") };
        else yield { type: "text", text: "Done" };
        yield { type: "usage", usage: { input: 10, output: 5, cached: 0 } };
        yield { type: "done" };
      },
    };
    const permissions = new PermissionGate("yolo");
    const architecture = createArchitectureService();
    const workflows = await createLocalWorkflows({
      root,
      stateDirectory,
      registry,
      provider,
      architecture,
      store,
      permissions,
      runtime: () => runtime,
    });
    const runtime: AgentRuntime = new AgentRuntime({
      root,
      provider,
      architecture,
      store,
      tools: registry,
      permissions,
      beforeTool: workflows.beforeTool,
      executeTool: workflows.executeTool,
      inspectUncertain: workflows.inspectUncertain,
      afterToolEffect: async () => {
        throw new Error("controlled crash after journal finalization");
      },
    });
    let runId = "";
    try {
      await expect(runtime.run("Fix the order", new AbortController().signal)).rejects.toThrow(
        "controlled crash",
      );
      runId = runtime.currentSession!.id;
      expect(await readFile(join(root, "order.py"), "utf8")).toBe(fixed);
      expect((await workflows.journal.inspect(runId)).pending).toBeUndefined();
      expect(await workflows.journal.inspectUncertain(runId, "crash-after-journal")).toContain(
        "discount_percent / 100",
      );
    } finally {
      store.close();
    }
    await expect(
      resolveTool(root, runId, "crash-after-journal", "fail", undefined, { stateDirectory }),
    ).rejects.toThrow("attribute");
    await resolveTool(root, runId, "crash-after-journal", "fail", "attribute", { stateDirectory });
    const restartedJournal = new RunJournal(root, { stateDirectory });
    await restartedJournal.rollback(runId);
    expect(await readFile(join(root, "order.py"), "utf8")).toBe(original);
    expect(requests).toBe(1);
  });
  test("uncertain reads with command hooks require explicit change attribution", async () => {
    const { root, stateDirectory } = await fixture();
    await mkdir(join(root, ".vcli"));
    await writeFile(
      join(root, ".vcli/hooks.json"),
      JSON.stringify({
        version: 1,
        beforeTool: [
          { name: "effect", tools: ["files_read"], command: "printf hooked > hook-output.txt" },
        ],
      }),
    );
    const store = await SqliteSessionStore.open(root, { directory: stateDirectory });
    const registry = new ToolRegistry();
    fileTools.forEach((tool) => registry.register({ ...tool, eager: true }));
    const provider: ProviderAdapter = {
      id: "read-hook-fixture",
      model: "read-hook-fixture",
      contextWindow: 32_768,
      async *stream() {
        yield {
          type: "tool-call",
          call: { id: "uncertain-hook", name: "files_read", arguments: { path: "order.py" } },
        };
        yield { type: "done" };
      },
    };
    const permissions = new PermissionGate("yolo");
    const architecture = createArchitectureService();
    const workflows = await createLocalWorkflows({
      root,
      stateDirectory,
      registry,
      provider,
      architecture,
      store,
      permissions,
      runtime: () => runtime,
    });
    const runtime: AgentRuntime = new AgentRuntime({
      root,
      provider,
      architecture,
      store,
      tools: registry,
      permissions,
      beforeTool: workflows.beforeTool,
      sideEffectCost: workflows.sideEffectCost,
      executeTool: workflows.executeTool,
      afterToolEffect: async () => {
        throw new Error("controlled compound read crash");
      },
    });
    let runId = "";
    try {
      await expect(runtime.run("Inspect source", new AbortController().signal)).rejects.toThrow(
        "controlled",
      );
      runId = runtime.currentSession!.id;
      expect(runtime.currentSession!.runState!.calls["uncertain-hook"]).toMatchObject({
        kind: "read",
        sideEffects: 1,
      });
      expect((await workflows.journal.inspect(runId)).pending).toBeUndefined();
      expect(await readFile(join(root, "hook-output.txt"), "utf8")).toBe("hooked");
    } finally {
      store.close();
    }
    await expect(
      resolveTool(root, runId, "uncertain-hook", "fail", undefined, { stateDirectory }),
    ).rejects.toThrow("attribute");
    await resolveTool(root, runId, "uncertain-hook", "fail", "attribute", { stateDirectory });
    await new RunJournal(root, { stateDirectory }).rollback(runId);
    await expect(readFile(join(root, "hook-output.txt"))).rejects.toThrow();
  });

  test("strict journals never serialize denied directory contents", async () => {
    const { root, directory, stateDirectory, context } = await fixture();
    await mkdir(join(root, "private"));
    const secret = "policy-denied-content-should-never-be-serialized";
    await writeFile(join(root, "private/secret.txt"), secret);
    const policyPath = join(directory, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        commands: { allow: [], deny: [] },
        directories: { allow: ["."], deny: ["private"] },
      }),
    );
    const policy = await ProjectPolicy.load(root, policyPath);
    const journal = new RunJournal(root, { stateDirectory, policy });
    const token = await journal.before(call("restricted-edit"), context);
    await writeFile(join(root, "order.py"), fixed);
    await journal.after(token);
    const stored = await readFile(join(stateDirectory, `${context.sessionId}.json`), "utf8");
    expect(stored).not.toContain("private/secret.txt");
    expect(stored).not.toContain(Buffer.from(secret).toString("base64"));
    await journal.rollback(context.sessionId);
    expect(await readFile(join(root, "private/secret.txt"), "utf8")).toBe(secret);
  });
  test("Bash changes are journaled and excluded private/generated files are not read", async () => {
    const { root, context, journal } = await fixture();
    await mkdir(join(root, ".vcli"));
    await writeFile(join(root, ".vcli/config.json"), "personal config must stay untouched");
    const shellCall: ToolCall = {
      id: "shell-edit",
      name: "shell_run",
      arguments: { command: "printf 'shell output' > shell.txt" },
    };
    const token = await journal.before(shellCall, context);
    await shellTool.execute(shellCall.arguments, context);
    await journal.after(token);
    expect((await journal.inspect(context.sessionId)).paths).toEqual(["shell.txt"]);
    await journal.rollback(context.sessionId);
    expect(await readFile(join(root, ".vcli/config.json"), "utf8")).toBe(
      "personal config must stay untouched",
    );
    await expect(stat(join(root, "shell.txt"))).rejects.toThrow();
  });
});
