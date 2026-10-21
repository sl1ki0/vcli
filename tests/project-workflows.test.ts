import { afterEach, describe, expect, test } from "bun:test";
import { access, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, PermissionGate, type ToolContext } from "@vcli/core";
import { createMemoryTools, loadProjectMemory } from "../apps/cli/src/workflows/memory.ts";
import { HookBlockedError, loadProjectHooks } from "../apps/cli/src/workflows/hooks.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vcli-workflows-"));
  roots.push(root);
  await mkdir(join(root, ".vcli"));
  return root;
}
function context(root: string, signal = new AbortController().signal): ToolContext {
  return { root, sessionId: "test-session", signal };
}
const call = {
  id: "call-1",
  name: "files_patch",
  arguments: { path: "source.ts", newText: "hello" },
};
async function hooks(root: string, config: object, gate = new PermissionGate("yolo")) {
  await writeFile(join(root, ".vcli/hooks.json"), JSON.stringify({ version: 1, ...config }));
  return loadProjectHooks(root, gate);
}

describe("project memory", () => {
  test("reloads root instruction files, gives explicit user instructions priority, and stays bounded", async () => {
    const root = await fixture();
    await writeFile(join(root, "AGENTS.md"), "Use strict TypeScript.");
    await writeFile(join(root, "CLAUDE.md"), "Use focused modules.");
    await writeFile(join(root, ".vcli/MEMORY.md"), "Decision: keep the runtime portable.");
    const first = await loadProjectMemory(root, { userInstructions: "Use concise prose." });
    expect(first.sources.map((source) => source.path)).toEqual([
      "User instructions",
      "AGENTS.md",
      "CLAUDE.md",
      ".vcli/MEMORY.md",
    ]);
    expect(first.text).toContain("runtime portable");
    await writeFile(join(root, "AGENTS.md"), "Updated externally.");
    expect((await loadProjectMemory(root)).text).toContain("Updated externally.");
    await writeFile(join(root, "AGENTS.md"), "😀".repeat(20_000));
    const bounded = await loadProjectMemory(root, { tokenBudget: 200 });
    expect(estimateTokens(bounded.text)).toBeLessThanOrEqual(200);
    expect(bounded.text).not.toContain("�");
    expect(bounded.diagnostics.length).toBeGreaterThan(0);
    expect((await loadProjectMemory(root, { tokenBudget: 0 })).text).toBe("");
  });

  test("reports unreadable instruction sources without losing remaining memory", async () => {
    const root = await fixture();
    await mkdir(join(root, "AGENTS.md"));
    await writeFile(join(root, "CLAUDE.md"), "Retained instructions.");
    const memory = await loadProjectMemory(root);
    expect(memory.diagnostics[0]).toContain("AGENTS.md");
    expect(memory.text).toContain("Retained instructions");
  });

  test("automatic instructions and memory reads reject linked external content", async () => {
    const root = await fixture();
    const external = await fixture();
    const secret = join(external, "synthetic-secret.txt");
    await writeFile(secret, "synthetic external secret");
    await symlink(secret, join(root, "AGENTS.md"));
    await link(secret, join(root, "CLAUDE.md"));
    await symlink(secret, join(root, ".vcli/MEMORY.md"));
    const loaded = await loadProjectMemory(root);
    expect(loaded.text).not.toContain("synthetic external secret");
    expect(loaded.sources).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(3);
    await expect(createMemoryTools()[0]!.execute({}, context(root))).rejects.toThrow();
    await rm(join(root, ".vcli/MEMORY.md"));
    await link(secret, join(root, ".vcli/MEMORY.md"));
    await expect(createMemoryTools()[0]!.execute({}, context(root))).rejects.toThrow("hard links");
    await expect(
      createMemoryTools()[1]!.execute({ text: "replace", expectedRevision: null }, context(root)),
    ).rejects.toThrow("hard links");
    expect(await readFile(secret, "utf8")).toBe("synthetic external secret");
  });

  test("memory refuses a symlinked parent directory before reading external files", async () => {
    const root = await fixture();
    const external = await fixture();
    await writeFile(join(external, "MEMORY.md"), "synthetic external memory");
    await rm(join(root, ".vcli"), { recursive: true });
    await symlink(external, join(root, ".vcli"));
    expect((await loadProjectMemory(root)).text).not.toContain("synthetic external memory");
    await expect(createMemoryTools()[0]!.execute({}, context(root))).rejects.toThrow("symbolic");
    await expect(
      createMemoryTools()[1]!.execute({ text: "replace", expectedRevision: null }, context(root)),
    ).rejects.toThrow("symbolic");
    expect(await readFile(join(external, "MEMORY.md"), "utf8")).toBe("synthetic external memory");
  });

  test("FIFO instruction and hook files fail without waiting for a writer", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    const fifo = join(root, ".vcli/MEMORY.md");
    const hookFifo = join(root, ".vcli/hooks.json");
    expect(
      await Bun.spawn(["mkfifo", fifo, hookFifo], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);
    const memoryModule = join(import.meta.dir, "../apps/cli/src/workflows/memory.ts");
    const hookModule = join(import.meta.dir, "../apps/cli/src/workflows/hooks.ts");
    const script = `
import { loadProjectMemory } from ${JSON.stringify(memoryModule)};
import { loadProjectHooks } from ${JSON.stringify(hookModule)};
const memory = await loadProjectMemory(${JSON.stringify(root)});
if (memory.sources.length || !memory.diagnostics.length) process.exit(2);
try { await loadProjectHooks(${JSON.stringify(root)}, {}); process.exit(3); } catch {}
`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(watchdog);
      child.kill("SIGKILL");
    }
  });

  test("memory writes require the current revision and the shared write permission", async () => {
    const root = await fixture();
    const [read, write] = createMemoryTools();
    expect(read!.kind).toBe("read");
    expect(write!.kind).toBe("write");
    await expect(new PermissionGate("read-only").authorize(write!, {})).rejects.toThrow(
      "Read-only",
    );
    await write!.execute({ text: "First decision.", expectedRevision: null }, context(root));
    const memory = await read!.execute({}, context(root));
    const revision = (memory.details as { revision: string }).revision;
    expect(memory.text).toContain(revision);
    await writeFile(join(root, ".vcli/MEMORY.md"), "External decision.");
    await expect(
      write!.execute({ text: "Stale decision.", expectedRevision: revision }, context(root)),
    ).rejects.toThrow("changed");
    expect(await readFile(join(root, ".vcli/MEMORY.md"), "utf8")).toBe("External decision.");
    await expect(
      write!.execute({ text: "x".repeat(12_001), expectedRevision: revision }, context(root)),
    ).rejects.toThrow("4000");
  });

  test("memory writes cannot replace symlinks and canceled writes do not start", async () => {
    const root = await fixture();
    const target = join(root, "external.txt");
    await writeFile(target, "Preserve");
    await symlink(target, join(root, ".vcli/MEMORY.md"));
    const write = createMemoryTools()[1]!;
    await expect(
      write.execute({ text: "No", expectedRevision: null }, context(root)),
    ).rejects.toThrow("regular file");
    expect(await readFile(target, "utf8")).toBe("Preserve");
    await expect(
      write.execute({ text: "No", expectedRevision: null }, context(root, AbortSignal.abort())),
    ).rejects.toThrow();
  });
});

describe("project command hooks", () => {
  test("reports whether commands require serialized execution", async () => {
    const root = await fixture();
    expect((await loadProjectHooks(root, new PermissionGate("yolo"))).hasHooks).toBe(false);
    expect((await hooks(root, { beforeTool: [] })).hasHooks).toBe(false);
    expect(
      (await hooks(root, { afterTool: [{ name: "configured", command: "true" }] })).hasHooks,
    ).toBe(true);
  });
  test("matches exact tool names, receives structured stdin, and reloads external edits", async () => {
    const root = await fixture();
    const runner = await hooks(root, {
      beforeTool: [
        { name: "ignored", tools: ["files_read"], command: "exit 9" },
        { name: "inspect", command: "cat" },
      ],
    });
    const reports = await runner.beforeTool(call, context(root));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0]!.output)).toMatchObject({
      event: "beforeTool",
      sessionId: "test-session",
      tool: call,
    });
    const updated = await hooks(root, { beforeTool: [{ name: "new", command: "printf updated" }] });
    expect((await updated.beforeTool(call, context(root)))[0]!.output).toBe("updated");
  });

  test("nonzero before hooks block, after hooks preserve completed tool outcomes", async () => {
    const root = await fixture();
    const runner = await hooks(root, {
      beforeTool: [{ name: "check", command: "printf stop; exit 2" }],
      afterTool: [{ name: "notify", command: "printf failed; exit 3" }],
    });
    await expect(runner.beforeTool(call, context(root))).rejects.toBeInstanceOf(HookBlockedError);
    expect(
      (await runner.afterTool(call, { text: "Already changed" }, context(root)))[0]!.status,
    ).toBe("failed");
    const payloadRunner = await hooks(root, { afterTool: [{ name: "payload", command: "cat" }] });
    const payload = JSON.parse(
      (
        await payloadRunner.afterTool(
          call,
          { text: "summary", fullOutput: "large artifact", details: { private: true } },
          context(root),
        )
      )[0]!.output,
    );
    expect(payload.result).toEqual({ text: "summary" });
  });

  test("all hook commands use the permission boundary, including hooks on read tools", async () => {
    const root = await fixture();
    const config = { beforeTool: [{ name: "command", command: "touch should-not-exist" }] };
    const readonly = await hooks(root, config, new PermissionGate("read-only"));
    await expect(
      readonly.beforeTool({ ...call, name: "files_read" }, context(root)),
    ).rejects.toThrow("Read-only");
    const approvals: string[] = [];
    const ask = await hooks(
      root,
      config,
      new PermissionGate("ask", async (tool) => {
        approvals.push(tool.name);
        return false;
      }),
    );
    await expect(ask.beforeTool(call, context(root))).rejects.toThrow("Approval denied");
    expect(approvals).toEqual(["hook.beforeTool.command"]);
    await expect(readFile(join(root, "should-not-exist"))).rejects.toThrow();
  });

  test("times out and cancels process groups, caps captured output", async () => {
    const root = await fixture();
    const timeout = await hooks(root, {
      beforeTool: [{ name: "slow", command: "trap '' TERM; sleep 10", timeoutMs: 30 }],
    });
    await expect(timeout.beforeTool(call, context(root))).rejects.toThrow("timeout");
    const controller = new AbortController();
    const cancel = await hooks(root, { beforeTool: [{ name: "cancel", command: "sleep 10" }] });
    const pending = cancel.beforeTool(call, context(root, controller.signal));
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow("aborted");
    const large = await hooks(root, {
      afterTool: [{ name: "large", command: "head -c 100000 /dev/zero" }],
    });
    const report = (await large.afterTool(call, { text: "done" }, context(root)))[0]!;
    expect(Buffer.byteLength(report.output)).toBeLessThanOrEqual(16_384);
    expect(report.truncated).toBe(true);
  });

  test("cancellation escalates after the shell exits with a resistant descendant", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    await writeFile(
      join(root, "descendant.ts"),
      `import { closeSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
closeSync(1); closeSync(2);
writeFileSync("ready", String(process.pid));
setTimeout(() => { writeFileSync("survived", "escaped"); }, 900);
`,
    );
    const executable = "'" + process.execPath.replaceAll("'", "'\"'\"'") + "'";
    const controller = new AbortController();
    const runner = await hooks(root, {
      beforeTool: [{ name: "descendant", command: `${executable} descendant.ts & wait` }],
    });
    const pending = runner.beforeTool(call, context(root, controller.signal));
    try {
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {
        if (
          await access(join(root, "ready")).then(
            () => true,
            () => false,
          )
        )
          break;
        await Bun.sleep(10);
      }
      expect(
        await access(join(root, "ready")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      controller.abort();
      await expect(pending).rejects.toThrow("aborted");
      await Bun.sleep(950);
      await expect(access(join(root, "survived"))).rejects.toThrow();
    } finally {
      controller.abort();
      await pending.catch(() => {});
      try {
        process.kill(Number(await readFile(join(root, "ready"), "utf8")), "SIGKILL");
      } catch {}
    }
  });

  test("successful hook shell exit drains unsupported background work", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    await writeFile(
      join(root, "background.ts"),
      `
import { closeSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
closeSync(1); closeSync(2);
writeFileSync("ready", String(process.pid));
setTimeout(() => { writeFileSync("survived", "escaped"); }, 900);
`,
    );
    const executable = "'" + process.execPath.replaceAll("'", "'\"'\"'") + "'";
    const runner = await hooks(root, {
      afterTool: [
        {
          name: "background",
          command: `${executable} background.ts & while ! test -f ready; do sleep 0.01; done`,
        },
      ],
    });
    try {
      const reports = await runner.afterTool(call, { text: "completed" }, context(root));
      expect(reports[0]!.status).toBe("failed");
      expect(reports[0]!.output).toContain("Background subprocesses were terminated");
      await Bun.sleep(950);
      await expect(access(join(root, "survived"))).rejects.toThrow();
    } finally {
      try {
        process.kill(Number(await readFile(join(root, "ready"), "utf8")), "SIGKILL");
      } catch {}
    }
  });

  test("hook configuration rejects linked external files and parent directories", async () => {
    const root = await fixture();
    const external = await fixture();
    const target = join(external, "hooks.json");
    await writeFile(target, JSON.stringify({ version: 1 }));
    await symlink(target, join(root, ".vcli/hooks.json"));
    await expect(loadProjectHooks(root, new PermissionGate("yolo"))).rejects.toThrow();
    await rm(join(root, ".vcli/hooks.json"));
    await link(target, join(root, ".vcli/hooks.json"));
    await expect(loadProjectHooks(root, new PermissionGate("yolo"))).rejects.toThrow("hard links");
    await rm(join(root, ".vcli"), { recursive: true });
    await symlink(external, join(root, ".vcli"));
    await expect(loadProjectHooks(root, new PermissionGate("yolo"))).rejects.toThrow("symbolic");
  });

  test("rejects malformed and oversized configuration without silently skipping checks", async () => {
    const root = await fixture();
    for (const config of [
      { version: 2 },
      { unsupported: [] },
      { beforeTool: [{ name: "bad", command: "echo", tools: ["files_.*"] }] },
      { afterTool: [{ name: "bad", command: "echo", timeoutMs: 1 }] },
    ])
      await expect(hooks(root, config)).rejects.toThrow();
    await writeFile(join(root, ".vcli/hooks.json"), " ".repeat(65_537));
    await expect(loadProjectHooks(root, new PermissionGate("yolo"))).rejects.toThrow("64 KiB");
  });
});
