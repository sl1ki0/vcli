import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ManagedRuntime, type ManagedRun, type ProviderAdapter } from "@vcli/core";
import { HomeworkExecutor } from "../apps/cli/src/workflows/homework/executor.ts";
import { HomeworkPolicy } from "../apps/cli/src/workflows/homework/policy.ts";
import { HomeworkJournal } from "../apps/cli/src/workflows/homework/journal.ts";
import { HomeworkStore } from "../apps/cli/src/workflows/homework/store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-homework-journal-")));
  directories.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root);
  await writeFile(
    join(root, "order.py"),
    "def calculate_total(prices, discount):\n    return sum(prices) - discount\n",
  );
  await writeFile(join(root, "test_order.py"), "# tests must remain unchanged\n");
  const policyPath = join(directory, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      commands: { allow: ["python3 -m unittest -v"], deny: ["rm"] },
      directories: { allow: ["."], deny: ["private"] },
    }),
  );
  const policy = await HomeworkPolicy.open(root, policyPath);
  const journal = new HomeworkJournal(policy);
  const initial = await journal.capture();
  const run: ManagedRun = {
    version: 1,
    revision: 0,
    id: "journal-test",
    root,
    policyPath,
    mode: "auto",
    phase: "execution",
    status: "running",
    goal: "fix",
    messages: [],
    limits: { modelRequests: 5, toolCalls: 10, sideEffects: 5, resultBytes: 1000 },
    spent: { modelRequests: 0, toolCalls: 0, sideEffects: 0, resultBytes: 0 },
    calls: [],
    batch: [],
    batchIndex: 0,
    journal: { initial, expected: structuredClone(initial), changes: [] },
  };
  return { directory, root, policy, journal, run };
}

describe("homework full tree journal", () => {
  test("persists diff and restores order.py after reopening SQLite, preserving tests and mode", async () => {
    const { directory, root, journal, run } = await fixture();
    await chmod(join(root, "order.py"), 0o751);
    run.journal.initial = await journal.capture();
    run.journal.expected = structuredClone(run.journal.initial);
    const original = await readFile(join(root, "order.py"));
    const tests = await readFile(join(root, "test_order.py"));
    await journal.before(run);
    await writeFile(
      join(root, "order.py"),
      "def calculate_total(prices, discount):\n    if not 0 <= discount <= 100: raise ValueError()\n    return sum(prices) * (1 - discount / 100)\n",
    );
    await journal.after(run);
    const database = join(directory, "runs.sqlite");
    const store = new HomeworkStore(database);
    await store.save(run);
    store.close();
    const reopened = new HomeworkStore(database);
    const saved = await reopened.get(run.id);
    const diff = await journal.inspect(saved);
    expect(diff).toContain("--- a/order.py");
    expect(diff).toContain("+    if not 0 <= discount <= 100");
    await journal.rollback(saved);
    expect(await readFile(join(root, "order.py"))).toEqual(original);
    expect(await readFile(join(root, "test_order.py"))).toEqual(tests);
    expect((await stat(join(root, "order.py"))).mode & 0o777).toBe(0o751);
    reopened.close();
  });

  test("captures creation and deletion, restores only run files", async () => {
    const { root, journal, run } = await fixture();
    await journal.before(run);
    await writeFile(join(root, "created.txt"), "new");
    await unlink(join(root, "order.py"));
    await journal.after(run);
    expect(run.journal.changes.map((change) => change.path)).toEqual(["created.txt", "order.py"]);
    await writeFile(join(root, "unrelated.txt"), "human");
    await journal.rollback(run);
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("human");
    expect(await readFile(join(root, "order.py"), "utf8")).toContain("sum(prices) - discount");
    expect(await Bun.file(join(root, "created.txt")).exists()).toBe(false);
    expect(run.status).toBe("rolled-back");
    expect(await journal.inspect(run)).toContain("created.txt");
    expect(run.journal.changes).toHaveLength(2);
  });

  test("retains touched files that return to original and create-then-delete paths", async () => {
    const { root, journal, run } = await fixture();
    const original = await readFile(join(root, "order.py"));
    await journal.before(run);
    await writeFile(join(root, "order.py"), "temporary agent edit");
    await writeFile(join(root, "temporary.txt"), "temporary agent file");
    await journal.after(run);
    await journal.before(run);
    await writeFile(join(root, "order.py"), original);
    await unlink(join(root, "temporary.txt"));
    await journal.after(run);
    expect(run.journal.changes.map((change) => change.path)).toEqual(["order.py", "temporary.txt"]);
    expect(run.journal.changes[0]!.before).toEqual(run.journal.changes[0]!.after);
    expect(run.journal.changes[1]!.before).toBeUndefined();
    expect(run.journal.changes[1]!.after).toBeUndefined();
    await journal.rollback(run);
    expect(await readFile(join(root, "order.py"))).toEqual(original);
    expect(await Bun.file(join(root, "temporary.txt")).exists()).toBe(false);
    expect(await journal.inspect(run)).toContain("temporary.txt");
  });

  test("rechecks hashes after staging and rejects late conflict before deleting another file", async () => {
    const { root, policy, journal, run } = await fixture();
    await journal.before(run);
    await writeFile(join(root, "order.py"), "agent");
    await writeFile(join(root, "created.txt"), "agent-created");
    await journal.after(run);
    const originalPath = policy.path.bind(policy);
    let checks = 0;
    policy.path = async (value, kind) => {
      const resolved = await originalPath(value, kind);
      if (value === "order.py" && ++checks === 2)
        await writeFile(join(root, "order.py"), "late human edit");
      return resolved;
    };
    await expect(journal.rollback(run)).rejects.toThrow("Rollback conflict");
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("agent-created");
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("late human edit");
    expect((await journal.capture())["created.txt"]).toBeDefined();
    expect(
      Object.keys(await journal.capture()).some((path) => path.startsWith(".vcli-rollback-")),
    ).toBe(false);
  });

  test("a conflict on one file prevents restoration of every file", async () => {
    const { root, journal, run } = await fixture();
    await journal.before(run);
    await writeFile(join(root, "order.py"), "agent");
    await writeFile(join(root, "created.txt"), "agent-created");
    await journal.after(run);
    await writeFile(join(root, "order.py"), "human");
    await expect(journal.rollback(run)).rejects.toThrow("Rollback conflict");
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("agent-created");
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("human");
    await expect(journal.before(run)).rejects.toThrow("Project conflict");
  });

  test("creation, deletion and mode changes outside run block next effect", async () => {
    for (const action of ["create", "delete", "mode"]) {
      const { root, journal, run } = await fixture();
      if (action === "create") await writeFile(join(root, "external"), "external");
      if (action === "delete") await unlink(join(root, "test_order.py"));
      if (action === "mode") await chmod(join(root, "order.py"), 0o711);
      await expect(journal.before(run)).rejects.toThrow("Project conflict");
    }
  });

  test("rejects symlinks, hardlinks and tampered backup before restoring", async () => {
    const { root, journal, run } = await fixture();
    await symlink(join(root, "order.py"), join(root, "linked"));
    await expect(journal.capture()).rejects.toThrow("symlink");
    await unlink(join(root, "linked"));
    await link(join(root, "order.py"), join(root, "hardlink"));
    await expect(journal.capture()).rejects.toThrow("linked");
    await unlink(join(root, "hardlink"));
    await journal.before(run);
    await writeFile(join(root, "order.py"), "agent");
    await journal.after(run);
    run.journal.changes[0]!.before!.content = Buffer.from("tampered").toString("base64");
    await expect(journal.rollback(run)).rejects.toThrow("hash mismatch");
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("agent");
  });

  test("policy denial is checked on all rollback paths before any writes", async () => {
    const { root, journal, run } = await fixture();
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private/secret"), "initial");
    run.journal.initial = await journal.capture();
    run.journal.expected = structuredClone(run.journal.initial);
    await journal.before(run);
    await writeFile(join(root, "order.py"), "agent");
    await writeFile(join(root, "private/secret"), "changed");
    await journal.after(run);
    await expect(journal.rollback(run)).rejects.toThrow();
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("agent");
  });

  test("uncertain effect is displayed and cannot be silently attributed or rolled back", async () => {
    const { root, journal, run } = await fixture();
    await journal.before(run);
    run.status = "uncertain";
    await writeFile(join(root, "order.py"), "effect before crash");
    expect(await journal.inspect(run)).toContain("not attributed to this run");
    expect(run.journal.changes).toEqual([]);
    await expect(journal.rollback(run)).rejects.toThrow("Resolve uncertain");
  });
});

describe("homework SQLite store", () => {
  test("private database files reject symlink and hardlink destinations", async () => {
    const { directory } = await fixture();
    const path = join(directory, "state.sqlite");
    const store = new HomeworkStore(path);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (await Bun.file(path + suffix).exists())
        expect((await stat(path + suffix)).mode & 0o777).toBe(0o600);
    }
    store.close();
    const symlinkPath = join(directory, "linked.sqlite");
    await symlink(path, symlinkPath);
    expect(() => new HomeworkStore(symlinkPath)).toThrow("links");
    await unlink(symlinkPath);
    const hardlinkPath = join(directory, "hardlinked.sqlite");
    await link(path, hardlinkPath);
    expect(() => new HomeworkStore(hardlinkPath)).toThrow("links");
    await unlink(hardlinkPath);
    const parentLink = join(directory, "linked-parent");
    await symlink(directory, parentLink);
    expect(() => new HomeworkStore(join(parentLink, "another.sqlite"))).toThrow("links");
  });

  test("atomic revisions preserve counters and reject stale writers", async () => {
    const { directory, run } = await fixture();
    const path = join(directory, "state.sqlite");
    const store = new HomeworkStore(path);
    await store.save(run);
    const stale = await store.get(run.id);
    run.spent.toolCalls = 3;
    await store.save(run);
    stale.spent.toolCalls = 1;
    await expect(store.save(stale)).rejects.toThrow("another process");
    expect(stale.revision).toBe(1);
    expect((await store.get(run.id)).spent.toolCalls).toBe(3);
    store.close();
  });

  test("exclusive run lock rejects live competing commands and releases after failure", async () => {
    const { directory } = await fixture();
    const path = join(directory, "state.sqlite");
    const first = new HomeworkStore(path);
    const second = new HomeworkStore(path);
    await first.withLock("run", async () => {
      await expect(second.withLock("run", async () => {})).rejects.toThrow("active");
    });
    await expect(
      first.withLock("run", async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    await second.withLock("run", async () => {});
    first.close();
    second.close();
  });

  test("another process cannot enter a live run and can recover its lock after process death", async () => {
    const { directory } = await fixture();
    const path = join(directory, "state.sqlite");
    const store = new HomeworkStore(path);
    const modulePath = join(process.cwd(), "apps/cli/src/workflows/homework/store.ts");
    const source = `import { HomeworkStore } from ${JSON.stringify(modulePath)};
      const store = new HomeworkStore(${JSON.stringify(path)});
      await store.withLock("cross-process", async () => { console.log("LOCKED"); await Bun.sleep(60000); });`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("LOCKED");
      await expect(store.withLock("cross-process", async () => {})).rejects.toThrow("active");
      child.kill("SIGKILL");
      await child.exited;
      await store.withLock("cross-process", async () => {});
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      store.close();
    }
  }, 5000);

  test("lock recovers only after owning process is dead", async () => {
    const { directory } = await fixture();
    const path = join(directory, "state.sqlite");
    const store = new HomeworkStore(path);
    const db = new Database(path);
    db.query("INSERT INTO homework_locks(id, owner, pid) VALUES (?, ?, ?)").run(
      "run",
      "dead",
      2147483647,
    );
    await store.withLock("run", async () => {});
    expect(db.query("SELECT id FROM homework_locks").all()).toEqual([]);
    db.close();
    store.close();
  });
});

describe("homework durable crash integration", () => {
  test("effect-before-result failure survives restart and requires explicit change attribution before rollback", async () => {
    const { directory, root, policy, journal } = await fixture();
    const database = join(directory, "runs.sqlite");
    let modelTurn = 0;
    const provider: ProviderAdapter = {
      id: "crash-fixture",
      model: "offline",
      contextWindow: 32768,
      async *stream() {
        if (modelTurn++ === 0)
          yield {
            type: "tool-call",
            call: {
              id: "edit",
              name: "write_file",
              arguments: { path: "order.py", content: "fixed by agent\n" },
            },
          };
        else yield { type: "text", text: "Done" };
        yield { type: "done" };
      },
    };
    const executor = new HomeworkExecutor(policy);
    const store = new HomeworkStore(database);
    const runtime = new ManagedRuntime({
      provider,
      executor,
      journal,
      store,
      fault: (point) => {
        if (point === "after-effect") throw new Error("controlled crash");
      },
    });
    const run = await runtime.create({
      id: "crash",
      root,
      policyPath: policy.policyPath,
      goal: "fix",
      mode: "auto",
    });
    await expect(runtime.advance(run, new AbortController().signal)).rejects.toThrow(
      "controlled crash",
    );
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("fixed by agent\n");
    store.close();
    const reopened = new HomeworkStore(database);
    const recovered = await reopened.get("crash");
    expect(recovered.calls[0]!.state).toBe("started");
    expect(recovered.spent).toEqual({
      modelRequests: 1,
      toolCalls: 1,
      sideEffects: 1,
      resultBytes: 0,
    });
    const resumed = new ManagedRuntime({ provider, executor, journal, store: reopened });
    await resumed.advance(recovered, new AbortController().signal);
    expect(recovered.status).toBe("uncertain");
    expect(recovered.calls[0]!.attempts).toBe(1);
    expect(await journal.inspect(recovered)).toContain("fixed by agent");
    await expect(journal.rollback(recovered)).rejects.toThrow("Resolve uncertain");
    await expect(resumed.resolve(recovered, "edit", "fail")).rejects.toThrow("explicitly adopt");
    await expect(resumed.resolve(recovered, "edit", "retry")).rejects.toThrow("Only read tools");
    await resumed.resolve(recovered, "edit", "fail", true);
    expect(recovered.journal.changes).toHaveLength(1);
    expect(recovered.calls[0]!.decisions.at(-1)!.action).toBe("fail-and-adopt");
    await resumed.advance(recovered, new AbortController().signal);
    expect(recovered.status).toBe("complete");
    expect(recovered.spent.sideEffects).toBe(1);
    expect(recovered.calls[0]!.attempts).toBe(1);
    await journal.rollback(recovered);
    await reopened.save(recovered);
    reopened.close();
    const finalStore = new HomeworkStore(database);
    const rolled = await finalStore.get("crash");
    expect(rolled.status).toBe("rolled-back");
    expect(await journal.inspect(rolled)).toContain("fixed by agent");
    expect(await readFile(join(root, "order.py"), "utf8")).toContain("sum(prices) - discount");
    finalStore.close();
  });

  test("budget reservation survives crash before execution without double charge", async () => {
    const { directory, root, policy, journal } = await fixture();
    const database = join(directory, "runs.sqlite");
    let modelTurn = 0;
    const provider: ProviderAdapter = {
      id: "budget-fixture",
      model: "offline",
      contextWindow: 32768,
      async *stream() {
        if (modelTurn++ === 0)
          yield {
            type: "tool-call",
            call: {
              id: "edit",
              name: "write_file",
              arguments: { path: "order.py", content: "fixed\n" },
            },
          };
        else yield { type: "text", text: "Done" };
        yield { type: "done" };
      },
    };
    const executor = new HomeworkExecutor(policy);
    const store = new HomeworkStore(database);
    const runtime = new ManagedRuntime({
      provider,
      executor,
      journal,
      store,
      fault: (point) => {
        if (point === "after-budget") throw new Error("reservation crash");
      },
    });
    const run = await runtime.create({
      id: "reserved",
      root,
      policyPath: policy.policyPath,
      goal: "fix",
      mode: "auto",
    });
    await expect(runtime.advance(run, new AbortController().signal)).rejects.toThrow(
      "reservation crash",
    );
    expect(await readFile(join(root, "order.py"), "utf8")).toContain("sum(prices) - discount");
    store.close();
    const reopened = new HomeworkStore(database);
    const recovered = await reopened.get("reserved");
    expect(recovered.calls[0]!.state).toBe("pending");
    expect(recovered.spent.toolCalls).toBe(1);
    expect(recovered.spent.sideEffects).toBe(1);
    await new ManagedRuntime({ provider, executor, journal, store: reopened }).advance(
      recovered,
      new AbortController().signal,
    );
    expect(recovered.status).toBe("complete");
    expect(recovered.spent.toolCalls).toBe(1);
    expect(recovered.spent.sideEffects).toBe(1);
    expect(recovered.calls[0]!.attempts).toBe(1);
    expect(await readFile(join(root, "order.py"), "utf8")).toBe("fixed\n");
    reopened.close();
  });
});
