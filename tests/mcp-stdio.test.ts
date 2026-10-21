import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "@vcli/integrations";
import { sandboxedMcpTransport } from "../apps/cli/src/workflows/mcp-transport.ts";
const temporary: string[] = [];
async function temp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vcli-mcp-stdio-")));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function mcpFixture(root: string): Promise<string> {
  const path = join(root, "fixture-server.ts");
  await writeFile(
    path,
    await readFile(join(import.meta.dir, "../packages/integrations/test/fixture-server.ts")),
  );
  return path;
}
describe("sandboxed stdio MCP", () => {
  test("stdio discovery starts the configured executable exactly once", async () => {
    const root = await temp();
    const counter = join(root, "startup-count.txt");
    const manager = new McpManager(
      [
        {
          name: "once",
          type: "stdio",
          command: process.execPath,
          args: [await mcpFixture(root)],
          env: { START_COUNT_FILE: counter },
        },
      ],
      { stdioTransport: sandboxedMcpTransport(root) },
    );
    try {
      expect(await manager.discover()).toHaveLength(4);
      expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual(["started"]);
    } finally {
      await manager.disconnect();
    }
  });

  test("SDK stdio connection negotiates legacy protocol, paginates tools, and reads resources", async () => {
    const root = await temp();
    const manager = new McpManager(
      [
        {
          name: "sample.fixture",
          type: "stdio",
          command: process.execPath,
          args: [await mcpFixture(root)],
        },
      ],
      { stdioTransport: sandboxedMcpTransport(root) },
    );
    try {
      const tools = await manager.discover();
      expect(tools).toHaveLength(4);
      expect(tools.every((tool) => tool.eager === false)).toBe(true);
      expect(
        tools.every((tool) => tool.name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(tool.name)),
      ).toBe(true);
      const echo = tools.find((tool) => tool.description.endsWith("Echo input"))!;
      const result = await echo.execute(
        { value: "hello" },
        { root: process.cwd(), sessionId: "test", signal: new AbortController().signal },
      );
      expect(result.text).toContain("hello");
      expect(result.fullOutput).toContain("hello");
      expect(await manager.listResources("sample.fixture")).toHaveLength(1);
      expect((await manager.readResource("sample.fixture", "fixture://report")).text).toContain(
        "Full resource content",
      );
    } finally {
      await manager.disconnect();
    }
  });

  test("an uncertain mutation is sent once and requires explicit reconnect", async () => {
    const root = await temp();
    const count = join(root, "count");
    const diagnostics: string[] = [];
    const manager = new McpManager(
      [
        {
          name: "sample.fixture",
          type: "stdio",
          command: process.execPath,
          args: [await mcpFixture(root)],
          env: { COUNT_FILE: count },
        },
      ],
      {
        stdioTransport: sandboxedMcpTransport(root),
        onDiagnostic: (text) => diagnostics.push(text),
      },
    );
    const tools = await manager.discover();
    const uncertain = tools.find((tool) =>
      tool.description.endsWith("Drops after executing once"),
    )!;
    const context = { root, sessionId: "test", signal: new AbortController().signal };
    await expect(uncertain.execute({}, context)).rejects.toThrow("not replayed");
    expect(await readFile(count, "utf8").catch(() => undefined)).toBeUndefined();
    expect(diagnostics.join("\n").match(/uncertain fixture executed/g)).toHaveLength(1);
    await expect(uncertain.execute({}, context)).rejects.toThrow("reconnect");
    expect(await readFile(count, "utf8").catch(() => undefined)).toBeUndefined();
    expect(diagnostics.join("\n").match(/uncertain fixture executed/g)).toHaveLength(1);
    expect(await manager.reconnect("sample.fixture")).toHaveLength(4);
    await manager.disconnect();
  });
});
