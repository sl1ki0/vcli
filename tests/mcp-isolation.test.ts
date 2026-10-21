import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "@vcli/integrations";
import {
  sandboxedMcpTransport,
  mcpEnvironment,
  isolatedMcpTransport,
} from "../apps/cli/src/workflows/mcp-transport.ts";
import { executeProcess } from "../apps/cli/src/tools/process.ts";
import { prepareSandbox } from "../apps/cli/src/workflows/process-sandbox.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vcli-mcp-isolation-")));
  roots.push(root);
  return root;
}
async function fixture(root: string, body: string): Promise<string> {
  const path = join(root, "server.ts");
  await writeFile(
    path,
    `import {createInterface} from 'node:readline'; import {readFileSync,writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',async line=>{ const request=JSON.parse(line); if(request.id===undefined)return;
let result; if(request.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(request.method==='tools/list') result={tools:[{name:'probe',description:'Probe isolation',inputSchema:{type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false}}]};
else if(request.method==='tools/call'){ const mode=request.params.arguments.mode; const value=await(async()=>{${body}})(); result={content:[{type:'text',text:JSON.stringify(value)}]}; }
else result={}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n'); });`,
  );
  return path;
}
const context = (root: string) => ({
  root,
  sessionId: "isolation-test",
  signal: new AbortController().signal,
});

test("MCP environment rejects runtime injection and never inherits arbitrary parent values", () => {
  process.env.VCLI_SYNTHETIC_PARENT_TOKEN = "parent-only";
  try {
    expect(
      mcpEnvironment({ EXPLICIT_TOKEN: "explicit" }).VCLI_SYNTHETIC_PARENT_TOKEN,
    ).toBeUndefined();
    expect(mcpEnvironment({ EXPLICIT_TOKEN: "explicit" }).EXPLICIT_TOKEN).toBe("explicit");
    expect(() => mcpEnvironment({ NODE_OPTIONS: "--require=attacker" })).toThrow("injection");
    expect(() => mcpEnvironment({ PYTHONPATH: "attacker" })).toThrow("injection");
  } finally {
    delete process.env.VCLI_SYNTHETIC_PARENT_TOKEN;
  }
});

test("closing an MCP connection aborts preparation before a late server can spawn", async () => {
  let cancelled = false;
  const factory = isolatedMcpTransport(async (_, signal) => {
    await new Promise<void>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          reject(signal.reason);
        },
        { once: true },
      ),
    );
    throw new Error("A cancelled launcher must never spawn");
  });
  const transport = factory(
    { name: "fixture", type: "stdio", command: "unused" },
    { maxResponseBytes: 1024 },
  );
  const pending = transport.start();
  const closing = transport.close();
  await expect(pending).rejects.toThrow("closed");
  await closing;
  expect(cancelled).toBe(true);
});

test("sandboxed Bun run can resolve its current directory through ancestor directories", async () => {
  const root = await temporary();
  await writeFile(join(root, "cwd.ts"), "console.log(process.cwd());");
  const result = await executeProcess(process.execPath, ["run", "cwd.ts"], context(root));
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(root);
});

test("initial executable selection cannot grant access to private host scripts", async () => {
  const root = await temporary();
  const outside = await temporary();
  const command = join(outside, "private-script");
  await writeFile(command, "#!/bin/sh\nprintf private-script-must-not-run");
  await chmod(command, 0o700);
  await expect(
    prepareSandbox({ root, cwd: root, command, args: [], access: "read" }),
  ).rejects.toThrow("refuses executables outside");
});

test.skipIf(!Bun.which("bun"))(
  "shells can execute the exact host Bun runtime outside public system directories",
  async () => {
    const root = await temporary();
    const result = await executeProcess(
      "/bin/bash",
      ["-c", "bun -e 'process.stdout.write(\"known-runtime\")'"],
      context(root),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("known-runtime");
  },
);

test.skipIf(process.platform !== "darwin")(
  "sandboxed macOS Python enters its actual interpreter without a forbidden spawn wrapper",
  async () => {
    const root = await temporary();
    const result = await executeProcess(
      "/usr/bin/python3",
      ["-c", "print('python-direct')"],
      context(root),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("python-direct");
    const shell = await executeProcess(
      "/bin/bash",
      ["-c", "python3 -c 'print(\"python-shell\")'"],
      context(root),
    );
    expect(shell.code).toBe(0);
    expect(shell.stdout.trim()).toBe("python-shell");
  },
);

test("reserved isolation failures discard staged writes while ordinary command failures retain them", async () => {
  const root = await temporary();
  const refused = await executeProcess(
    "/bin/sh",
    ["-c", "printf pending > refused.txt; exit 125"],
    context(root),
  );
  expect(refused.code).toBe(125);
  expect(refused.stderr).toContain("staged changes were discarded");
  expect(await Bun.file(join(root, "refused.txt")).exists()).toBe(false);
  const ordinary = await executeProcess(
    "/bin/sh",
    ["-c", "printf observed > ordinary.txt; exit 1"],
    context(root),
  );
  expect(ordinary.code).toBe(1);
  expect(await readFile(join(root, "ordinary.txt"), "utf8")).toBe("observed");
});

test("stdio MCP denies external files, private paths, network and inherited secrets while importing authorized writes", async () => {
  const root = await temporary();
  const outside = await temporary();
  const secret = join(outside, "synthetic-secret");
  const escaped = join(outside, "escaped");
  await writeFile(secret, "synthetic private value");
  let requests = 0;
  const endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("unexpected");
    },
  });
  const path = await fixture(
    root,
    `if(mode==='write'){writeFileSync('created.txt','authorized');return 'ok'} const blocked=fn=>{try{fn();return false}catch{return true}}; let network=false;try{await fetch(${JSON.stringify(endpoint.url.href)})}catch{network=true} return {read:blocked(()=>readFileSync(${JSON.stringify(secret)})),write:blocked(()=>writeFileSync(${JSON.stringify(escaped)},'escaped')),private:blocked(()=>writeFileSync('.env','forbidden')),network,parent:process.env.VCLI_SYNTHETIC_PARENT_TOKEN??null,explicit:process.env.EXPLICIT_TOKEN};`,
  );
  process.env.VCLI_SYNTHETIC_PARENT_TOKEN = "parent-only";
  const manager = new McpManager(
    [
      {
        name: "fixture",
        type: "stdio",
        command: process.execPath,
        args: [path],
        env: { EXPLICIT_TOKEN: "explicit" },
      },
    ],
    { stdioTransport: sandboxedMcpTransport(root) },
  );
  try {
    const tool = (await manager.discover())[0]!;
    expect(tool).toBeDefined();
    const result = await tool.execute({ mode: "probe" }, context(root));
    expect(JSON.parse(result.text)).toEqual({
      read: true,
      write: true,
      private: true,
      network: true,
      parent: null,
      explicit: "explicit",
    });
    expect(requests).toBe(0);
    await tool.execute({ mode: "write" }, context(root));
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("authorized");
    expect(await readFile(escaped, "utf8").catch(() => undefined)).toBeUndefined();
  } finally {
    delete process.env.VCLI_SYNTHETIC_PARENT_TOKEN;
    await manager.disconnect();
    endpoint.stop(true);
  }
});

test("stdio MCP rejects delayed filesystem mutations before another request can import them", async () => {
  const root = await temporary();
  const path = await fixture(
    root,
    `if(mode==='background')setTimeout(()=>writeFileSync('delayed.txt','background'),150);return 'ok';`,
  );
  const manager = new McpManager(
    [{ name: "fixture", type: "stdio", command: process.execPath, args: [path] }],
    { stdioTransport: sandboxedMcpTransport(root) },
  );
  try {
    const tool = (await manager.discover())[0]!;
    await tool.execute({ mode: "background" }, context(root));
    await Bun.sleep(250);
    await expect(tool.execute({ mode: "probe" }, context(root))).rejects.toThrow("not replayed");
    expect(
      await readFile(join(root, "delayed.txt"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await manager.disconnect();
  }
});

test("installed MCP package executes from a read-only snapshot and cannot broaden cwd grants", async () => {
  const root = await temporary();
  const installed = await temporary();
  const path = await fixture(
    installed,
    `let denied=false;try{writeFileSync('server.ts','replaced')}catch{denied=true}writeFileSync(process.env.PROJECT+'/plugin-output.txt','authorized');return {denied};`,
  );
  const original = await readFile(path, "utf8");
  const manager = new McpManager(
    [
      {
        name: "fixture",
        type: "stdio",
        command: process.execPath,
        args: [path],
        cwd: installed,
        env: { PROJECT: root, PLUGIN_ROOT: installed },
      },
    ],
    { stdioTransport: sandboxedMcpTransport(root, new Map([["fixture", installed]])) },
  );
  try {
    const tool = (await manager.discover())[0]!;
    expect(JSON.parse((await tool.execute({ mode: "probe" }, context(root))).text)).toEqual({
      denied: true,
    });
    expect(await readFile(join(root, "plugin-output.txt"), "utf8")).toBe("authorized");
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await manager.disconnect();
  }
  const untrusted = new McpManager(
    [
      {
        name: "fixture",
        type: "stdio",
        command: process.execPath,
        args: [path],
        cwd: installed,
        env: { PLUGIN_ROOT: installed },
      },
    ],
    { stdioTransport: sandboxedMcpTransport(root) },
  );
  expect(await untrusted.discover()).toEqual([]);
  expect(untrusted.diagnostics.join("\n")).toContain("working directory must stay");
  await untrusted.disconnect();
});

test("oversized MCP frames disconnect before staged writes can reach the project", async () => {
  const root = await temporary();
  const path = await fixture(
    root,
    "writeFileSync('uncommitted.txt','pending');return 'x'.repeat(8192);",
  );
  const diagnostics: string[] = [];
  const manager = new McpManager(
    [{ name: "fixture", type: "stdio", command: process.execPath, args: [path] }],
    {
      stdioTransport: sandboxedMcpTransport(root),
      maxResponseBytes: 2048,
      onDiagnostic: (text) => diagnostics.push(text),
    },
  );
  try {
    const tool = (await manager.discover())[0]!;
    await expect(tool.execute({ mode: "probe" }, context(root))).rejects.toThrow("not replayed");
    expect(diagnostics.join("\n")).toContain("exceeded 2048 bytes");
    expect(
      await readFile(join(root, "uncommitted.txt"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await manager.disconnect();
  }
});
