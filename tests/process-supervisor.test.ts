import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProcessSupervisor } from "../apps/cli/src/workflows/process-supervisor.ts";

const roots: string[] = [];
const profile =
  "(version 1)(allow default)(deny syscall-unix (syscall-number 147)(syscall-number 82)(syscall-number 244))";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.skipIf(process.platform !== "darwin")(
  "native supervisor kills background descendants kept in its sandbox process group",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-supervisor-test-"));
    roots.push(root);
    const marker = join(root, "escaped");
    const executable = await prepareProcessSupervisor();
    const leader = `(/bin/sleep 0.6; printf escaped > '${marker}') </dev/null >/dev/null 2>&1 & printf spawned`;
    const child = Bun.spawn(
      [
        executable,
        "--parent",
        String(process.pid),
        "--",
        "/usr/bin/sandbox-exec",
        "-p",
        profile,
        "/bin/sh",
        "-c",
        leader,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await new Response(child.stdout).text()).toContain("spawned");
    expect(await child.exited).toBe(125);
    expect(await new Response(child.stderr).text()).toContain("Background subprocesses");
    await Bun.sleep(750);
    expect(await readFile(marker, "utf8").catch(() => undefined)).toBeUndefined();
  },
);

test.skipIf(process.platform !== "darwin")(
  "native supervisor drains its immutable child group when the owning process is killed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-supervisor-parent-test-"));
    roots.push(root);
    const marker = join(root, "escaped");
    const ready = join(root, "ready");
    const executable = await prepareProcessSupervisor();
    const leader = `(/bin/sleep 1.2; printf escaped > '${marker}') </dev/null >/dev/null 2>&1 & printf ready > '${ready}'; /bin/sleep 5`;
    const owner = `require('node:child_process').spawn(${JSON.stringify(executable)}, ['--parent', String(process.pid), '--', '/usr/bin/sandbox-exec', '-p', ${JSON.stringify(profile)}, '/bin/sh', '-c', ${JSON.stringify(leader)}], {detached:true,stdio:'ignore'}).unref(); setTimeout(()=>{},5000);`;
    const child = Bun.spawn([process.execPath, "-e", owner], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 200 && !(await Bun.file(ready).exists()); attempt++)
        await Bun.sleep(10);
      expect(await Bun.file(ready).exists()).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      await Bun.sleep(1400);
      expect(await readFile(marker, "utf8").catch(() => undefined)).toBeUndefined();
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "native supervisor verifies every process-group escape syscall is denied",
  async () => {
    const executable = await prepareProcessSupervisor();
    const confined = Bun.spawn(
      ["/usr/bin/sandbox-exec", "-p", profile, executable, "--probe-detachment"],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await confined.exited).toBe(0);
    const unrestricted = Bun.spawn([executable, "--probe-detachment"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await unrestricted.exited).toBe(125);
  },
);
