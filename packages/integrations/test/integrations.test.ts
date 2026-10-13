import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
  loadPlugin,
  loadSkill,
  McpManager,
  mcpResult,
  PluginManager,
  type McpConnection,
} from "../src/index.ts";
import { response, type RpcRequest } from "./fixture-server.ts";

const temporary: string[] = [];
const run = promisify(execFile);
const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

async function temp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vcli-integrations-")));
  temporary.push(root);
  return root;
}
async function put(root: string, path: string, value: string | unknown): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}
async function skill(
  root: string,
  name = "inspect",
  body = "Inspect the architecture.",
): Promise<void> {
  await put(
    root,
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: >-\n  Inspect architecture with exact evidence.\n---\n${body}\n`,
  );
}
async function portable(root: string, name = "sample"): Promise<void> {
  await put(root, "plugin.json", { $schema: pluginSchema, name, version: "1.0.0" });
  await skill(root);
}
function failStateWrites(manager: PluginManager): () => void {
  const internal = manager as unknown as { save: (state: unknown) => Promise<void> };
  const save = internal.save.bind(manager);
  internal.save = async () => {
    throw new Error("Injected state write failure");
  };
  return () => {
    internal.save = save;
  };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin import adapters", () => {
  test("portable discovery returns metadata and loads instructions on demand", async () => {
    const root = await temp();
    await portable(root);
    await put(root, "skills/README.md", "Documentation should not interrupt skill discovery.");
    await put(root, "mcp.json", {
      $schema: mcpSchema,
      mcpServers: {
        graph: {
          type: "stdio",
          command: "bun",
          args: ["${PLUGIN_ROOT}/server.ts"],
          env: { STORE: "${PLUGIN_DATA}" },
        },
      },
    });
    const plugin = await loadPlugin(root);
    expect(plugin.ecosystem).toBe("portable");
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills[0]).not.toHaveProperty("body");
    expect(await loadSkill("sample:inspect", plugin.skills)).toContain("Inspect the architecture.");
    expect(plugin.servers[0]?.name).toBe("sample.graph");
    expect(plugin.servers[0]?.args).toEqual([join(root, "server.ts")]);
    expect(plugin.servers[0]?.env?.PLUGIN_ROOT).toBe(root);
  });

  test.each(["claude", "codex"] as const)(
    "%s manifest resolves custom skills and reports host components",
    async (ecosystem) => {
      const root = await temp();
      await put(root, `.${ecosystem}-plugin/plugin.json`, {
        name: "sample",
        version: "1.0.0",
        skills: "./extra",
        hooks: "./hooks.json",
        apps: "./.app.json",
        mcpServers: "./servers.json",
      });
      await skill(root);
      await put(
        root,
        "extra/inspect-extra/SKILL.md",
        "---\nname: inspect-extra\ndescription: Inspect another module.\n---\nExtra instructions.",
      );
      await put(root, "servers.json", {
        mcpServers: {
          graph: {
            command: "bun",
            args: [`\${${ecosystem === "claude" ? "CLAUDE" : "CODEX"}_PLUGIN_ROOT}/server.ts`],
          },
        },
      });
      const plugin = await loadPlugin(root);
      expect(plugin.ecosystem).toBe(ecosystem);
      expect(plugin.skills).toHaveLength(2);
      expect(plugin.servers[0]?.args).toEqual([join(root, "server.ts")]);
      expect(plugin.unsupported.join("\n")).toContain("hooks");
      expect(plugin.unsupported.join("\n")).toContain("apps");
    },
  );

  test("Gemini httpUrl is Streamable HTTP; url remains an unsupported SSE declaration", async () => {
    const root = await temp();
    await put(root, "gemini-extension.json", {
      name: "sample",
      version: "1.0.0",
      contextFileName: "GEMINI.md",
      mcpServers: {
        modern: { httpUrl: "https://example.com/mcp" },
        legacy: { url: "https://example.com/sse" },
        local: { command: "bun", args: ["${extensionPath}/server.ts"] },
      },
    });
    await skill(root);
    const plugin = await loadPlugin(root);
    expect(plugin.ecosystem).toBe("gemini");
    expect(plugin.servers).toHaveLength(2);
    expect(plugin.servers.find((server) => server.name.endsWith("modern"))?.type).toBe("http");
    expect(plugin.unsupported.join("\n")).toContain("legacy SSE");
  });

  test("rejects unsupported portable versions and validates namespace/path containment", async () => {
    const root = await temp();
    await portable(root);
    await put(root, "plugin.json", {
      $schema: "https://agent-plugins.org/schemas/99.0/plugin.schema.json",
      name: "sample",
    });
    await expect(loadPlugin(root)).rejects.toThrow("Unsupported portable plugin schema");
    await put(root, "plugin.json", { $schema: pluginSchema, name: "../escape" });
    await expect(loadPlugin(root)).rejects.toThrow("Plugin name");
    await put(root, "plugin.json", { $schema: pluginSchema, name: "sample" });
    const outside = await temp();
    await put(outside, "SKILL.md", "---\nname: escaped\ndescription: Outside.\n---\nEscape.");
    await symlink(outside, join(root, "skills/escaped"));
    const plugin = await loadPlugin(root);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.unsupported.join("\n")).toContain("Symlink escapes");
    await put(root, "mcp.json", {
      $schema: mcpSchema,
      mcpServers: {
        bad: { type: "stdio", command: "./../escape" },
        remote: { type: "streamable-http", url: "http://example.com/mcp" },
      },
    });
    const invalid = await loadPlugin(root);
    expect(invalid.servers).toHaveLength(0);
    expect(invalid.unsupported).toHaveLength(3);
  });

  test("a malformed MCP component does not disable valid skills", async () => {
    const root = await temp();
    await portable(root);
    await put(root, "mcp.json", "not json");
    const plugin = await loadPlugin(root);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.servers).toHaveLength(0);
    expect(plugin.unsupported[0]).toContain("MCP config");
  });

  test("native environment placeholders expand without placing missing credentials in diagnostics", async () => {
    const root = await temp();
    await put(root, ".claude-plugin/plugin.json", {
      name: "sample",
      mcpServers: {
        missing: { command: "bun", env: { TOKEN: "${VCLI_NONEXISTENT_FIXTURE_TOKEN}" } },
        fallback: { command: "bun", env: { TOKEN: "${VCLI_NONEXISTENT_FIXTURE_TOKEN:-fallback}" } },
      },
    });
    const plugin = await loadPlugin(root);
    expect(plugin.servers).toHaveLength(1);
    expect(plugin.servers[0]?.env?.TOKEN).toBe("fallback");
    expect(plugin.unsupported.join("\n")).toContain(
      "missing environment variable VCLI_NONEXISTENT_FIXTURE_TOKEN",
    );
  });

  test("portable schemas reject malformed known fields and retain supported dotted plugin names", async () => {
    const root = await temp();
    await portable(root, "sample.tools");
    expect((await loadPlugin(root)).name).toBe("sample.tools");
    await put(root, "plugin.json", { $schema: pluginSchema, name: "sample", description: 123 });
    await expect(loadPlugin(root)).rejects.toThrow("Invalid portable plugin manifest");
    await portable(root);
    await put(root, "mcp.json", {
      $schema: mcpSchema,
      mcpServers: { invalid: { type: "stdio", command: "bun", args: "script.ts" } },
    });
    const plugin = await loadPlugin(root);
    expect(plugin.servers).toHaveLength(0);
    expect(plugin.unsupported.join("\n")).toContain("invalid portable configuration");
  });

  test("unsupported vendor tool filters disable the server instead of widening its tool access", async () => {
    const root = await temp();
    await put(root, "gemini-extension.json", {
      name: "sample",
      mcpServers: { filtered: { command: "bun", excludeTools: ["delete"] } },
    });
    const plugin = await loadPlugin(root);
    expect(plugin.servers).toHaveLength(0);
    expect(plugin.unsupported.join("\n")).toContain("server disabled");
  });
});

describe("snapshot installation and catalogs", () => {
  test("local install copies a snapshot, does not run hooks, and preserves installed state on duplicates", async () => {
    const root = await temp();
    await portable(root);
    await put(root, "hooks/hooks.json", { command: "touch SHOULD_NOT_RUN" });
    const state = await temp();
    const manager = new PluginManager(state);
    const installed = await manager.install(root);
    await skill(root, "inspect", "Changed upstream instructions.");
    expect(await manager.loadSkill("sample:inspect")).toContain("Inspect the architecture.");
    expect(installed.root).toBe(join(state, "plugins/sample"));
    await expect(manager.install(root)).rejects.toThrow("already installed");
    expect(await manager.list()).toHaveLength(1);
    expect(() => manager.remove("../elsewhere")).toThrow();
    await manager.remove("sample");
    expect(await manager.list()).toHaveLength(0);
  });

  test("standalone skills keep their identity after the staging directory changes", async () => {
    const root = await temp();
    await put(
      root,
      "SKILL.md",
      "---\nname: inspect\ndescription: Inspect architecture.\n---\nUse precise evidence.",
    );
    const manager = new PluginManager(await temp());
    const plugin = await manager.install(root);
    expect(plugin.name).toBe("inspect");
    expect(plugin.skills).toHaveLength(1);
    expect(await manager.loadSkill("inspect")).toContain("Use precise evidence");
  });

  test("failed state writes roll back plugin installation and preserve plugin data on removal", async () => {
    const root = await temp();
    await portable(root);
    const state = await temp();
    const manager = new PluginManager(state);
    let restore = failStateWrites(manager);
    await expect(manager.install(root)).rejects.toThrow("state write failure");
    restore();
    expect(await manager.list()).toHaveLength(0);
    expect(await Bun.file(join(state, "plugins/sample/plugin.json")).exists()).toBe(false);
    expect(await Bun.file(join(state, "data/sample")).exists()).toBe(false);
    await manager.install(root);
    await put(state, "data/sample/persistent.txt", "Preserve user data.");
    restore = failStateWrites(manager);
    await expect(manager.remove("sample")).rejects.toThrow("state write failure");
    restore();
    expect(await manager.list()).toHaveLength(1);
    expect(await manager.loadSkill("sample:inspect")).toContain("Inspect the architecture.");
    expect(await readFile(join(state, "data/sample/persistent.txt"), "utf8")).toBe(
      "Preserve user data.",
    );
  });

  test("catalog refresh is explicit, rejects escapes, and supports Claude/OpenAI source paths", async () => {
    const root = await temp();
    await portable(join(root, "plugins/sample"));
    await put(root, ".claude-plugin/marketplace.json", {
      name: "local",
      plugins: [
        { name: "sample", source: "./plugins/sample" },
        { name: "bad", source: "./../escape" },
      ],
    });
    const manager = new PluginManager(await temp());
    const market = await manager.addMarketplace("local", root);
    expect(market.plugins).toHaveLength(1);
    expect(market.unsupported).toHaveLength(1);
    await manager.installFromMarketplace("local", "sample");
    await put(root, ".claude-plugin/marketplace.json", { name: "local", plugins: [] });
    expect((await manager.listMarketplaces())[0]?.plugins).toHaveLength(1);
    expect((await manager.refreshMarketplace("local")).plugins).toHaveLength(0);
    await manager.removeMarketplace("local");
    expect(await manager.listMarketplaces()).toHaveLength(0);
    expect(await manager.list()).toHaveLength(1);
    const openai = await temp();
    await portable(join(openai, "plugins/sample"));
    await put(openai, ".agents/plugins/marketplace.json", {
      plugins: [{ name: "sample", source: { path: "./plugins/sample" } }],
    });
    expect((await manager.addMarketplace("openai", openai)).plugins).toHaveLength(1);
  });

  test("Git installation records a SHA and can install a subdirectory at a pinned commit", async () => {
    const root = await temp();
    await portable(join(root, "plugins/sample"));
    await run("git", ["init", root]);
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ]);
    const revision = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await skill(join(root, "plugins/sample"), "inspect", "New upstream body.");
    const manager = new PluginManager(await temp());
    const plugin = await manager.install(pathToFileURL(root).href, {
      revision,
      subdir: "plugins/sample",
    });
    expect(plugin.revision).toBe(revision);
    expect(await manager.loadSkill("inspect")).toContain("Inspect the architecture.");
    await expect(
      manager.install(pathToFileURL(root).href, { subdir: "../outside" }),
    ).rejects.toThrow("Subdirectory");
  });

  test("failed catalog refresh and removal restore the prior snapshot", async () => {
    const root = await temp();
    await portable(join(root, "plugins/sample"));
    await put(root, "marketplace.json", {
      plugins: [{ name: "sample", source: "./plugins/sample" }],
    });
    const manager = new PluginManager(await temp());
    await manager.addMarketplace("local", root);
    await put(root, "marketplace.json", { plugins: [] });
    let restore = failStateWrites(manager);
    await expect(manager.refreshMarketplace("local")).rejects.toThrow("state write failure");
    restore();
    expect((await manager.listMarketplaces())[0]?.plugins).toHaveLength(1);
    restore = failStateWrites(manager);
    await expect(manager.removeMarketplace("local")).rejects.toThrow("state write failure");
    restore();
    expect((await manager.installFromMarketplace("local", "sample")).name).toBe("sample");
  });
});

describe("lazy MCP clients", () => {
  test("SDK stdio connection negotiates legacy protocol, paginates tools, and reads resources", async () => {
    const manager = new McpManager([
      {
        name: "sample.fixture",
        type: "stdio",
        command: process.execPath,
        args: [join(import.meta.dir, "fixture-server.ts")],
      },
    ]);
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

  test("SDK Streamable HTTP connects lazily and uses configured headers", async () => {
    let requests = 0;
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        requests++;
        authorization = request.headers.get("authorization");
        const result = response((await request.json()) as RpcRequest);
        return result ? Response.json(result) : new Response(null, { status: 202 });
      },
    });
    const manager = new McpManager([
      {
        name: "sample.http",
        type: "http",
        url: `http://127.0.0.1:${server.port}/mcp`,
        headers: { authorization: "Bearer test" },
      },
    ]);
    expect(requests).toBe(0);
    try {
      expect(await manager.discover()).toHaveLength(4);
      expect(String(authorization)).toBe("Bearer test");
    } finally {
      await manager.disconnect();
      server.stop(true);
    }
  });

  test("SDK negotiates modern MCP and attaches protocol metadata", async () => {
    let sawVersion: unknown;
    let initialized = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const rpc = (await request.json()) as RpcRequest;
        if (rpc.method === "server/discover")
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {}, resources: {} },
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1.0.0" } },
            },
          });
        if (rpc.method === "initialize") initialized = true;
        if (rpc.method === "tools/list")
          sawVersion = (rpc.params?._meta as Record<string, unknown> | undefined)?.[
            "io.modelcontextprotocol/protocolVersion"
          ];
        const result = response(rpc);
        if (result?.result && typeof result.result === "object")
          Object.assign(result.result, { resultType: "complete", ttlMs: 0, cacheScope: "public" });
        return result ? Response.json(result) : new Response(null, { status: 202 });
      },
    });
    const manager = new McpManager([
      { name: "sample.modern", type: "http", url: `http://127.0.0.1:${server.port}/mcp` },
    ]);
    try {
      const tools = await manager.discover();
      expect(manager.diagnostics).toEqual([]);
      expect(tools).toHaveLength(4);
      expect(initialized).toBe(false);
      expect(sawVersion).toBe("2026-07-28");
      const echo = tools.find((tool) => tool.description.endsWith("Echo input"))!;
      expect(
        (
          await echo.execute(
            { value: "modern" },
            { root: process.cwd(), sessionId: "test", signal: new AbortController().signal },
          )
        ).text,
      ).toContain("modern");
    } finally {
      await manager.disconnect();
      server.stop(true);
    }
  });

  test("an uncertain mutation is sent once and requires explicit reconnect", async () => {
    const root = await temp();
    const count = join(root, "count");
    const manager = new McpManager([
      {
        name: "sample.fixture",
        type: "stdio",
        command: process.execPath,
        args: [join(import.meta.dir, "fixture-server.ts")],
        env: { COUNT_FILE: count },
      },
    ]);
    const tools = await manager.discover();
    const uncertain = tools.find((tool) =>
      tool.description.endsWith("Drops after executing once"),
    )!;
    const context = { root, sessionId: "test", signal: new AbortController().signal };
    await expect(uncertain.execute({}, context)).rejects.toThrow("not replayed");
    expect(await readFile(count, "utf8")).toBe("executed");
    await expect(uncertain.execute({}, context)).rejects.toThrow("reconnect");
    expect(await readFile(count, "utf8")).toBe("executed");
    expect(await manager.reconnect("sample.fixture")).toHaveLength(4);
    await manager.disconnect();
  });

  test("cancellation reaches the connector and never retries the call", async () => {
    let connects = 0;
    let calls = 0;
    let closes = 0;
    const definition: Tool = { name: "wait", description: "Wait", inputSchema: { type: "object" } };
    const connection: McpConnection = {
      listTools: async () => [definition],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      close: async () => {
        closes++;
      },
      callTool: async (_, __, signal) => {
        calls++;
        return new Promise<CallToolResult>((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    };
    const manager = new McpManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      connector: async () => {
        connects++;
        return connection;
      },
    });
    expect(connects).toBe(0);
    const tools = await manager.discover();
    expect(connects).toBe(1);
    const controller = new AbortController();
    const pending = tools[0]!.execute(
      {},
      { root: process.cwd(), sessionId: "test", signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("Cancelled"));
    await expect(pending).rejects.toThrow("not replayed");
    expect(calls).toBe(1);
    expect(closes).toBe(1);
  });

  test("disconnect cancels pending discovery promptly and closes a connector that finishes late", async () => {
    let finish!: (connection: McpConnection) => void;
    let closes = 0;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const connection: McpConnection = {
      listTools: async () => [],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        closes++;
      },
    };
    const manager = new McpManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      connector: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = manager.discover();
    await starting;
    await manager.disconnect();
    expect(await pending).toEqual([]);
    finish(connection);
    await Promise.resolve();
    await Promise.resolve();
    expect(closes).toBe(1);
    expect(manager.diagnostics.join("\n")).toContain("disconnected");
  });

  test("full output is retained while binary bodies stay out of model text", () => {
    const result = mcpResult(
      {
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "image", mimeType: "image/png", data: "SECRET_BINARY" },
          { type: "resource_link", name: "report", uri: "fixture://report" },
        ],
        structuredContent: { status: "done" },
      },
      100,
    );
    expect(result.text.length).toBeLessThan(200);
    expect(result.text).not.toContain("SECRET_BINARY");
    expect(result.fullOutput).toContain("SECRET_BINARY");
    expect(result.fullOutput).toContain("fixture://report");
  });
});
