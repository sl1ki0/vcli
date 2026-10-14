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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@vcli/core";
import { HomeworkExecutor } from "../apps/cli/src/workflows/homework/executor.ts";
import {
  HomeworkPolicy,
  type HomeworkPolicyConfig,
} from "../apps/cli/src/workflows/homework/policy.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<HomeworkPolicyConfig> = {}) {
  const container = await mkdtemp(join(await realpath(tmpdir()), "vcli-homework-policy-"));
  roots.push(container);
  const root = join(container, "workspace");
  await mkdir(root);
  await mkdir(join(root, "private"));
  await writeFile(join(root, "order.py"), "original\n");
  await writeFile(join(root, "private", "secret.txt"), "denied");
  const policyPath = join(container, "policy.json");
  const config: HomeworkPolicyConfig = {
    version: 1,
    commands: {
      allow: ["python3 -m unittest -v", "echo allowed", "echo denied", "sleep 2", "yes"],
      deny: ["echo denied"],
    },
    directories: { allow: ["."], deny: ["private"] },
    timeoutMs: 1000,
    maxOutputBytes: 4096,
    ...overrides,
  };
  await writeFile(policyPath, JSON.stringify(config));
  const policy = await HomeworkPolicy.open(root, policyPath);
  return { container, root, policyPath, config, policy, executor: new HomeworkExecutor(policy) };
}
function call(name: string, arguments_: Record<string, unknown>): ToolCall {
  return { id: "test", name, arguments: arguments_ };
}
const signal = () => new AbortController().signal;

describe("homework exact command policy", () => {
  test("allowlist and deny precedence apply to the full command", async () => {
    const { policy, executor } = await fixture();
    policy.command("python3 -m unittest -v");
    policy.command("echo allowed");
    expect(() => policy.command("echo denied")).toThrow("denies");
    expect(() => policy.command("echo unknown")).toThrow("denies");
    expect(() => policy.command("echo allowed extra")).toThrow("denies");
    const result = await executor.execute(
      call("Bash", { command: "echo allowed", cwd: "." }),
      4096,
      signal(),
    );
    expect(JSON.parse(result.text)).toMatchObject({ stdout: "allowed\n", stderr: "", exitCode: 0 });
    expect(result.exitCode).toBe(0);
  });

  test("even configured shell syntax and interpreter escapes are rejected", async () => {
    const commands = [
      "echo allowed | cat",
      "echo allowed; pwd",
      "echo $(pwd)",
      "echo `pwd`",
      "echo allowed > order.py",
      "echo allowed\npwd",
      "echo 'allowed'",
      "echo *",
      "echo foo/bar",
      "echo ..",
      "bash -c pwd",
      "python3 -c print",
      "node --eval code",
      "env bash",
      "echo foo\\bar",
      "echo allowed && pwd",
      "python3 -m unittest test_order.py",
      "rm private",
      "cp source target",
      "python3 -m pip install example",
    ];
    const { policy } = await fixture({ commands: { allow: commands, deny: [] } });
    for (const command of commands) expect(() => policy.command(command)).toThrow();
  });

  test("allowed command in denied directory is rejected before spawn", async () => {
    const { executor } = await fixture();
    await expect(
      executor.check(call("Bash", { command: "echo allowed", cwd: "private" })),
    ).rejects.toThrow("denies");
    await expect(
      executor.execute(call("Bash", { command: "echo denied", cwd: "." }), 1024, signal()),
    ).rejects.toThrow("denies");
  });

  test("Bash uses fresh environment without inherited credentials or startup hooks", async () => {
    const { root, executor } = await fixture({
      commands: { allow: ["python3 -m unittest -v"], deny: [] },
    });
    await writeFile(
      join(root, "test_environment.py"),
      `import os, unittest\nclass EnvironmentTest(unittest.TestCase):\n def test_environment(self):\n  self.assertNotIn("VCLI_HOMEWORK_TEST_SECRET", os.environ)\n  self.assertNotIn("BASH_ENV", os.environ)\n  self.assertEqual(os.environ["PYTHONDONTWRITEBYTECODE"], "1")\n`,
    );
    const previous = process.env.VCLI_HOMEWORK_TEST_SECRET;
    process.env.VCLI_HOMEWORK_TEST_SECRET = "must-not-reach-child";
    try {
      const result = await executor.execute(
        call("Bash", { command: "python3 -m unittest -v", cwd: "." }),
        4096,
        signal(),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.text).stderr).toContain("OK");
    } finally {
      if (previous === undefined) delete process.env.VCLI_HOMEWORK_TEST_SECRET;
      else process.env.VCLI_HOMEWORK_TEST_SECRET = previous;
    }
  });
});

describe("homework workspace boundaries", () => {
  test("denied descendants, absolute paths and traversal are forbidden", async () => {
    const { root, policy, executor } = await fixture();
    for (const value of [
      "private/secret.txt",
      "private/child/new.txt",
      "../policy.json",
      "sub/../order.py",
      join(root, "order.py"),
      "../workspace/order.py",
    ])
      await expect(policy.path(value)).rejects.toThrow();
    const result = await executor.execute(call("list_files", { path: "." }), 4096, signal());
    expect(result.text).toBe("order.py");
    await expect(executor.check(call("read_file", { path: "private/secret.txt" }))).rejects.toThrow(
      "denies",
    );
  });

  test("rejects symlinks, linked ancestors, hardlinks and a symlink workspace", async () => {
    const { root, container, policyPath, policy } = await fixture();
    await symlink(join(root, "order.py"), join(root, "linked.py"));
    await symlink(root, join(root, "nested"));
    await link(join(root, "order.py"), join(root, "hard.py"));
    for (const value of ["linked.py", "nested/new.py", "hard.py", "order.py"])
      await expect(policy.path(value)).rejects.toThrow("links");
    await symlink(root, join(container, "alias"));
    await expect(HomeworkPolicy.open(join(container, "alias"), policyPath)).rejects.toThrow(
      "links",
    );
    await symlink(container, join(container, "parent-alias"));
    await expect(
      HomeworkPolicy.open(join(container, "parent-alias", "workspace"), policyPath),
    ).rejects.toThrow("links");
  });

  test("policy must be external and directory rules stay inside workspace", async () => {
    const { root, policyPath, config } = await fixture();
    await writeFile(join(root, "policy.json"), JSON.stringify(config));
    await expect(HomeworkPolicy.open(root, join(root, "policy.json"))).rejects.toThrow("outside");
    for (const value of ["../outside", root]) {
      await writeFile(
        policyPath,
        JSON.stringify({ ...config, directories: { allow: [value], deny: [] } }),
      );
      await expect(HomeworkPolicy.open(root, policyPath)).rejects.toThrow();
    }
  });

  test("invalid policy types, unknown fields and absent allow fail closed", async () => {
    const { root, policyPath, config } = await fixture();
    for (const invalid of [
      { ...config, timeoutMs: "100" },
      { ...config, extra: true },
      { ...config, commands: { deny: [] } },
      { ...config, directories: { allow: [false], deny: [] } },
    ]) {
      await writeFile(policyPath, JSON.stringify(invalid));
      await expect(HomeworkPolicy.open(root, policyPath)).rejects.toThrow();
    }
    const restricted = await fixture({ directories: { allow: ["private"], deny: [] } });
    await expect(restricted.policy.path("order.py")).rejects.toThrow("denies");
  });

  test("fresh checks catch symlinks substituted after validation", async () => {
    const { root, container, executor } = await fixture();
    const request = call("write_file", { path: "order.py", content: "wrong" });
    await executor.check(request);
    await rm(join(root, "order.py"));
    await writeFile(join(container, "outside.py"), "preserve");
    await symlink(join(container, "outside.py"), join(root, "order.py"));
    await expect(executor.execute(request, 1000, signal())).rejects.toThrow("links");
    expect(await readFile(join(container, "outside.py"), "utf8")).toBe("preserve");
  });
});

describe("homework physical executor", () => {
  test("strict schemas reject unknown calls, extra fields and coercion", async () => {
    const { executor } = await fixture();
    for (const request of [
      call("unknown", {}),
      call("read_file", { path: 10 }),
      call("write_file", { path: "order.py", content: null }),
      call("Bash", { command: "echo allowed", cwd: ".", extra: true }),
    ])
      expect(() => executor.validate(request)).toThrow();
    expect(executor.schemas.every((schema) => schema.description && schema.inputSchema)).toBe(true);
  });

  test("write preserves mode; create, read, missing-file error and delete work", async () => {
    const { root, executor } = await fixture();
    await chmod(join(root, "order.py"), 0o751);
    await executor.execute(
      call("write_file", { path: "order.py", content: "updated\n" }),
      1000,
      signal(),
    );
    expect((await stat(join(root, "order.py"))).mode & 0o777).toBe(0o751);
    expect(
      (await executor.execute(call("read_file", { path: "order.py" }), 1000, signal())).text,
    ).toBe("updated\n");
    await executor.execute(call("write_file", { path: "new.txt", content: "new" }), 1000, signal());
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
    expect(
      (await executor.execute(call("delete_file", { path: "new.txt" }), 1000, signal())).isError,
    ).not.toBe(true);
    expect(
      (await executor.execute(call("read_file", { path: "missing.txt" }), 1000, signal())).isError,
    ).toBe(true);
    expect(executor.kind("delete_file")).toBe("delete");
  });

  test("read, listing and Bash results fit remaining byte budget and mark truncation", async () => {
    const { root, executor } = await fixture();
    await writeFile(join(root, "order.py"), "🙂".repeat(1000));
    const read = await executor.execute(call("read_file", { path: "order.py" }), 13, signal());
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(13);
    expect(read.truncated).toBe(true);
    const listing = await executor.execute(call("list_files", { path: "." }), 2, signal());
    expect(listing.truncated).toBe(true);
    const output = await executor.execute(
      call("Bash", { command: "yes", cwd: "." }),
      200,
      signal(),
    );
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(200);
    expect(JSON.parse(output.text)).toHaveProperty("stdout");
    const tiny = await executor.execute(
      call("Bash", { command: "echo allowed", cwd: "." }),
      3,
      signal(),
    );
    expect(Buffer.byteLength(tiny.text)).toBeLessThanOrEqual(3);
    expect(tiny.truncated).toBe(true);
  });

  test("Bash timeout and cancellation return failure and drain child process", async () => {
    const { executor } = await fixture({ timeoutMs: 40 });
    const started = Date.now();
    const timed = await executor.execute(
      call("Bash", { command: "sleep 2", cwd: "." }),
      4096,
      signal(),
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(timed.isError).toBe(true);
    expect(JSON.parse(timed.text).error).toContain("timeout");
    const controller = new AbortController();
    const running = executor.execute(
      call("Bash", { command: "sleep 2", cwd: "." }),
      4096,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    const cancelled = await running;
    expect(cancelled.isError).toBe(true);
    expect(JSON.parse(cancelled.text).error).toContain("cancelled");
  });
});
