import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  linuxSeccompFilter,
  macSandboxProfile,
  prepareSandbox,
  sandboxEnvironment,
} from "../apps/cli/src/workflows/process-sandbox.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vcli-sandbox-test-"));
  temporary.push(path);
  return path;
}

function evaluate(filter: Buffer, syscall: number, architecture: number): number {
  let accumulator = 0;
  for (let index = 0; index < filter.length / 8; index++) {
    const offset = index * 8;
    const code = filter.readUInt16LE(offset);
    const value = filter.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = value === 4 ? architecture : syscall;
    else if (code === 0x15 || code === 0x35) {
      const yes = code === 0x15 ? accumulator === value : accumulator >= value;
      index += filter[offset + (yes ? 2 : 3)]!;
    } else if (code === 0x06) return value;
    else throw new Error("Unexpected BPF instruction");
  }
  throw new Error("BPF did not return a decision");
}

async function execute(
  root: string,
  script: string,
  command = "/bin/bash",
  args?: string[],
  readOnlyDirectories?: string[],
) {
  const prepared = await prepareSandbox({
    root,
    cwd: root,
    command,
    args: args ?? ["--noprofile", "--norc", "-c", script],
    staged: true,
    readOnlyDirectories,
  });
  try {
    return await new Promise<{ code: number | null; output: string }>((accept, reject) => {
      const child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["ignore", "pipe", "pipe", ...prepared.stdioFds],
      });
      let output = "";
      child.stdout!.on("data", (part) => {
        output += part;
      });
      child.stderr!.on("data", (part) => {
        output += part;
      });
      child.once("error", reject);
      child.once("close", (code) => accept({ code, output }));
    });
  } finally {
    await prepared.dispose();
  }
}

describe("system process isolation", () => {
  test("does not inherit provider credentials, startup code, proxies, or ambient home", () => {
    const previous = process.env.VCLI_SANDBOX_HOST_SECRET;
    process.env.VCLI_SANDBOX_HOST_SECRET = "private sentinel";
    try {
      const environment = sandboxEnvironment("/sandbox/home", "/sandbox/tmp", {
        MCP_TOKEN: "explicit",
        BASH_ENV: "/attacker",
        NODE_OPTIONS: "--require /attacker",
        PATH: "/attacker",
        DYLD_INSERT_LIBRARIES: "/attacker",
      });
      expect(environment.VCLI_SANDBOX_HOST_SECRET).toBeUndefined();
      expect(environment.MCP_TOKEN).toBe("explicit");
      expect(environment.BASH_ENV).toBeUndefined();
      expect(environment.NODE_OPTIONS).toBeUndefined();
      expect(environment.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(environment.PATH).not.toContain("/attacker");
      expect(environment.HOME).toBe("/sandbox/home");
    } finally {
      if (previous === undefined) delete process.env.VCLI_SANDBOX_HOST_SECRET;
      else process.env.VCLI_SANDBOX_HOST_SECRET = previous;
    }
  });

  test("rejects live-workspace write capability before creating sandbox resources", async () => {
    const root = await directory();
    await expect(
      prepareSandbox({ root, cwd: root, command: "/bin/true", args: [] }),
    ).rejects.toThrow("disposable staged workspace");
  });

  test("checks syscall architecture and blocks sockets, ptrace, namespace changes and io_uring", () => {
    for (const [architecture, audit, sockets, ptrace, unshare] of [
      ["x64", 0xc000003e, 41, 101, 272],
      ["arm64", 0xc00000b7, 198, 117, 97],
    ] as const) {
      const filter = linuxSeccompFilter(architecture);
      for (const syscall of [sockets, ptrace, unshare, 425, 426, 427, 438])
        expect(evaluate(filter, syscall, audit)).toBe(0x00050001);
      expect(evaluate(filter, 435, audit)).toBe(0x00050026);
      expect(evaluate(filter, 1, audit)).toBe(0x7fff0000);
      expect(evaluate(filter, 1, 0x40000003)).toBe(0x80000000);
    }
    expect(evaluate(linuxSeccompFilter("x64"), 0x40000001, 0xc000003e)).toBe(0x80000000);
    expect(() => linuxSeccompFilter("ia32")).toThrow("x64 and arm64");
  });

  test("seatbelt profiles contain no broad home, Data volume, network, or Mach IPC grant", () => {
    const profile = macSandboxProfile({
      root: "/stage/[quoted]",
      readDirectories: ["/stage/[quoted]"],
      writeDirectories: [],
      deniedPaths: ["/stage/[quoted]/secret"],
      executable: "/bin/bash",
      temporary: "/scratch",
      allowGitRead: false,
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(syscall-number 82)");
    expect(profile).toContain("(syscall-number 147)");
    expect(profile).toContain("(syscall-number 244)");
    expect(profile).not.toContain('(subpath "/System")');
    expect(profile).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain("(allow network");
    expect(profile).not.toContain("(allow mach-");
    expect(profile).toContain('(subpath "/stage/[quoted]/secret")');
  });

  const native = ["darwin", "linux"].includes(process.platform) ? test : test.skip;
  native(
    "permits staged shell work while blocking external file reads/writes and protected names",
    async () => {
      const root = await directory();
      const outside = await directory();
      await writeFile(join(root, "source.txt"), "staged source");
      await writeFile(join(outside, "sentinel.txt"), "HOST-SENTINEL");
      await writeFile(join(root, ".env"), "ENV-SENTINEL");
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git", "config"), "GIT-SENTINEL");
      const script = `cat source.txt; printf changed > result.txt; cat '${join(outside, "sentinel.txt")}'; printf escaped > '${join(outside, "sentinel.txt")}'; ln -s '${join(outside, "sentinel.txt")}' escape-link; cat escape-link; printf escaped > escape-link; cat .env; cat .git/config; mkdir .vcli`;
      const result = await execute(root, script);
      expect(result.output).toContain("staged source");
      expect(result.output).not.toContain("HOST-SENTINEL");
      expect(result.output).not.toContain("ENV-SENTINEL");
      expect(result.output).not.toContain("GIT-SENTINEL");
      expect(await readFile(join(root, "result.txt"), "utf8")).toBe("changed");
      expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("HOST-SENTINEL");
    },
  );

  native("protects trusted package contents from direct writes and hard-link aliases", async () => {
    const root = await directory();
    await mkdir(join(root, "package"));
    await writeFile(join(root, "package", "program"), "TRUSTED-CODE");
    await execute(
      root,
      "ln package/program alias; printf corrupt > alias; printf corrupt > package/program; mv package/program moved",
      "/bin/bash",
      undefined,
      [join(root, "package")],
    );
    expect(await readFile(join(root, "package", "program"), "utf8")).toBe("TRUSTED-CODE");
  });

  const linux = process.platform === "linux" ? test : test.skip;
  linux("consumes inherited host mount descriptors before launching the payload", async () => {
    const root = await directory();
    const outside = await directory();
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "HOST-FD-SENTINEL");
    const script = `const f=require("node:fs");let leak=false;for(let fd=3;fd<256;fd++){try{if(!f.fstatSync(fd).isDirectory())continue;const p="/proc/self/fd/"+fd+"/../../../../../../../../../../"+${JSON.stringify(sentinel.slice(1))};if(f.readFileSync(p,"utf8").includes("HOST-FD-SENTINEL"))leak=true}catch{}}console.log(leak?"LEAKED":"CLOSED");process.exit(leak?3:0);`;
    const result = await execute(root, "", process.execPath, ["--no-env-file", "-e", script]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("CLOSED");
    expect(result.output).not.toContain("LEAKED");
  });

  linux(
    "repeated launches preserve parent descriptor ownership",
    async () => {
      const root = await directory();
      const before = (await readdir("/proc/self/fd")).length;
      for (let index = 0; index < 30; index++) {
        const result = await execute(root, "printf okay");
        expect(result.code).toBe(0);
        expect(result.output).toBe("okay");
      }
      Bun.gc(true);
      await Bun.sleep(20);
      const after = (await readdir("/proc/self/fd")).length;
      expect(after - before).toBeLessThanOrEqual(4);
    },
    20_000,
  );

  native("denies connections to a listening host loopback service", async () => {
    const root = await directory();
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.end("HOST-NETWORK-SENTINEL");
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const script = `const n = require("node:net"); const s=n.createConnection({host:"127.0.0.1",port:${port}}); s.on("error",e=>{console.log("DENIED:"+e.code);process.exit(0)});s.on("data",d=>{console.log(d.toString());process.exit(3)});setTimeout(()=>process.exit(2),1000);`;
      const result = await execute(root, "", process.execPath, ["--no-env-file", "-e", script]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("DENIED:");
      expect(result.output).not.toContain("HOST-NETWORK-SENTINEL");
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  });
});
