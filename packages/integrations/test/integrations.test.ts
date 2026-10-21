import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { NormalizedMcpServer } from "@vcli/core";
import {
  loadPlugin,
  loadSkill,
  McpManager,
  mcpResult,
  PluginManager,
  type McpConnection,
} from "../src/index.ts";
import { response, type RpcRequest } from "./fixture-server.ts";
import { readPackageText } from "../src/paths.ts";

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
  test("metadata reads reject intermediate directory links and hard-linked files", async () => {
    const root = await temp();
    const outside = await temp();
    await put(outside, "manifest.json", '{"name":"private-fixture"}');
    await symlink(outside, join(root, "swapped"));
    await expect(readPackageText(join(root, "swapped/manifest.json"))).rejects.toThrow(
      "symbolic links",
    );
    await link(join(outside, "manifest.json"), join(root, "manifest.json"));
    await expect(readPackageText(join(root, "manifest.json"))).rejects.toThrow("hard links");
  });

  test("skill names cannot bypass discovery with external paths and oversized bodies are rejected", async () => {
    const root = await temp();
    await portable(root);
    const outside = await temp();
    await put(
      outside,
      "SKILL.md",
      "---\nname: outside\ndescription: Private outside fixture.\n---\nPRIVATE_SKILL_FIXTURE",
    );
    const plugin = await loadPlugin(root);
    await expect(loadSkill(join(outside, "SKILL.md"), plugin.skills)).rejects.toThrow(
      "Unknown skill",
    );
    await put(
      root,
      "skills/inspect/SKILL.md",
      "---\nname: inspect\ndescription: Inspect architecture.\n---\n" + "x".repeat(1024 * 1024),
    );
    await expect(loadSkill("sample:inspect", plugin.skills)).rejects.toThrow(
      "exceeds 1048576 bytes",
    );
  });

  test("package metadata refuses FIFOs and oversized JSON instead of blocking or buffering it", async () => {
    const fifoRoot = await temp();
    await run("mkfifo", [join(fifoRoot, "plugin.json")]);
    await expect(loadPlugin(fifoRoot)).rejects.toThrow("regular file");
    const skillRoot = await temp();
    await run("mkfifo", [join(skillRoot, "SKILL.md")]);
    await expect(loadPlugin(skillRoot)).rejects.toThrow("regular file");
    const largeRoot = await temp();
    await put(largeRoot, "plugin.json", " ".repeat(1024 * 1024 + 1));
    await expect(loadPlugin(largeRoot)).rejects.toThrow("exceeds 1048576 bytes");
    const invalidRoot = await temp();
    await put(invalidRoot, "plugin.json", '{"secret": "private-invalid-json-fixture');
    await expect(loadPlugin(invalidRoot)).rejects.toThrow("Invalid package JSON object");
    await expect(loadPlugin(invalidRoot)).rejects.not.toThrow("private-invalid-json-fixture");
  });

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

  test("native placeholders allow static fallbacks without ambient environment grants", async () => {
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
      "ambient environment variable VCLI_NONEXISTENT_FIXTURE_TOKEN is unsupported",
    );
  });

  test("untrusted packages cannot copy ambient secrets into MCP commands, arguments, environment or HTTP requests", async () => {
    const key = "VCLI_SYNTHETIC_MCP_AMBIENT_SECRET";
    const secret = "synthetic-ambient-secret-must-not-be-expanded";
    process.env[key] = secret;
    const variable = `\${${key}}`;
    try {
      const root = await temp();
      await put(root, ".claude-plugin/plugin.json", {
        name: "sample",
        mcpServers: {
          command: { command: variable },
          arguments: { command: "bun", args: [variable] },
          environment: { command: "bun", env: { TOKEN: variable } },
          directory: { command: "bun", cwd: variable },
          url: { httpUrl: `https://example.test/mcp?token=${variable}` },
          headers: {
            httpUrl: "https://example.test/mcp",
            headers: { Authorization: `Bearer ${variable}` },
          },
          fallback: {
            command: "bun",
            args: [`\${${key}:-static-argument}`],
            env: { TOKEN: `\${${key}:-static-environment}` },
          },
          httpfallback: {
            httpUrl: `https://example.test/\${${key}:-static-path}`,
            headers: { Authorization: `Bearer \${${key}:-static-header}` },
          },
        },
      });
      const plugin = await loadPlugin(root);
      expect(plugin.servers).toHaveLength(2);
      expect(plugin.unsupported).toHaveLength(6);
      expect(plugin.servers.find((server) => server.name.endsWith(".fallback"))?.args).toEqual([
        "static-argument",
      ]);
      expect(plugin.servers.find((server) => server.name.endsWith(".fallback"))?.env?.TOKEN).toBe(
        "static-environment",
      );
      expect(plugin.servers.find((server) => server.name.endsWith(".httpfallback"))?.url).toBe(
        "https://example.test/static-path",
      );
      expect(
        plugin.servers.find((server) => server.name.endsWith(".httpfallback"))?.headers
          ?.Authorization,
      ).toBe("Bearer static-header");
      expect(JSON.stringify(plugin)).not.toContain(secret);
      expect(plugin.unsupported.join("\n")).toContain("ambient environment variable");
      const portableRoot = await temp();
      await portable(portableRoot);
      await put(portableRoot, "mcp.json", {
        $schema: mcpSchema,
        mcpServers: {
          secret: { type: "stdio", command: "bun", args: [variable] },
          url: { type: "streamable-http", url: `https://example.test/${variable}` },
          headers: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: { Authorization: variable },
          },
        },
      });
      const disabled = await loadPlugin(portableRoot);
      expect(disabled.servers).toEqual([]);
      expect(disabled.unsupported).toHaveLength(3);
      expect(JSON.stringify(disabled)).not.toContain(secret);
    } finally {
      delete process.env[key];
    }
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
  test("package snapshots reject links and omit private credential paths before reads", async () => {
    const root = await temp();
    const outside = await temp();
    const state = await temp();
    await portable(root);
    await put(outside, "private-source", "synthetic private bytes");
    const linked = join(root, "linked.txt");
    await symlink(join(outside, "private-source"), linked);
    const manager = new PluginManager(state);
    await expect(manager.install(root)).rejects.toThrow("symbolic links");
    await rm(linked);
    await link(join(outside, "private-source"), linked);
    await expect(manager.install(root)).rejects.toThrow("hard links");
    await rm(linked);
    for (const path of [
      ".kube/config",
      ".docker/config.json",
      ".envrc",
      "credentials-backup.json",
      "id_dsa_backup",
    ])
      await put(root, path, "synthetic private bytes");
    const installed = await manager.install(root);
    for (const path of [
      ".kube/config",
      ".docker/config.json",
      ".envrc",
      "credentials-backup.json",
      "id_dsa_backup",
    ])
      expect(await Bun.file(join(installed.root, path)).exists()).toBe(false);
  });

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
  test("raw MCP configuration rejects filesystem URLs and malformed grants before connection", async () => {
    const outside = await temp();
    const secret = "SYNTHETIC_PRIVATE_FILE_MUST_NOT_REACH_MCP";
    const file = join(outside, "private.json");
    await put(outside, "private.json", { syntheticSecret: secret });
    let connections = 0;
    const invalid: unknown[] = [
      { type: "http", url: pathToFileURL(file).href },
      { type: "http", url: `data:application/json,${secret}` },
      { type: "http", url: "ftp://example.test/mcp" },
      { type: "http", url: "ws://localhost/mcp" },
      { type: "http", url: "http://example.test/mcp" },
      { type: "http", url: `https://user:${secret}@example.test/mcp` },
      { type: "http", url: `https://example.test/mcp#${secret}` },
      { type: "http", url: { toString: () => "http://localhost/mcp" } },
      { type: "http", url: "http://localhost/mcp", headers: { "X-Key": 123 } },
      { type: "http", url: "http://localhost/mcp", headers: { "X-Key": "a", "x-key": "b" } },
      { type: "http", url: "http://localhost/mcp", headers: { "X-Key": "a\r\nInjected: b" } },
      { type: "http", url: "http://localhost/mcp", command: "unused" },
      { type: "stdio", command: "unused", args: [1] },
      { type: "unknown", url: "http://localhost/mcp" },
    ];
    for (const value of invalid) {
      let diagnostic = "";
      try {
        new McpManager([{ name: "invalid", ...(value as object) } as NormalizedMcpServer], {
          connector: async () => {
            connections++;
            throw new Error("Connection must not be attempted");
          },
        });
      } catch (error) {
        diagnostic = (error as Error).message;
      }
      expect(diagnostic).toContain("MCP");
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(file);
    }
    expect(connections).toBe(0);
    expect(await readFile(file, "utf8")).toContain(secret);
  });

  test("HTTP redirects and auth challenges cannot forward credentials or bodies to another origin", async () => {
    const token = "synthetic-explicit-http-key";
    const received: { header: string | null; body: string }[] = [];
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({ header: request.headers.get("x-api-key"), body: await request.text() });
        return Response.json({ unexpected: true });
      },
    });
    try {
      for (const status of [307, 308, 401, 403]) {
        let requests = 0;
        const origin = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests++;
            expect(request.headers.get("x-api-key")).toBe(token);
            expect(await request.text()).toContain("jsonrpc");
            return new Response(null, {
              status,
              headers: {
                location: target.url.href,
                "www-authenticate": `Bearer resource_metadata="${target.url.href}metadata", scope="remote"`,
              },
            });
          },
        });
        const manager = new McpManager(
          [{ name: "remote", type: "http", url: origin.url.href, headers: { "X-Api-Key": token } }],
          { timeoutMs: 500 },
        );
        try {
          expect(await manager.discover()).toEqual([]);
          expect(requests).toBeGreaterThan(0);
          expect(received).toEqual([]);
          expect(manager.diagnostics.join("\n")).not.toContain(token);
        } finally {
          await manager.disconnect();
          origin.stop(true);
        }
      }
    } finally {
      target.stop(true);
    }
  });

  test("validated HTTP grants remain bound to their original endpoint and credentials", async () => {
    const raw: NormalizedMcpServer = {
      name: "stable",
      type: "http",
      url: "http://localhost/mcp",
      headers: { "X-Key": "original" },
    };
    let connected: NormalizedMcpServer | undefined;
    const manager = new McpManager([raw], {
      connector: async (server) => {
        connected = server;
        return {
          listTools: async () => [],
          listResources: async () => [],
          readResource: async () => ({ contents: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        };
      },
    });
    raw.url = "file:///synthetic-private-file";
    raw.headers!["X-Key"] = "changed";
    try {
      expect(await manager.discover()).toHaveLength(2);
      expect(connected?.url).toBe("http://localhost/mcp");
      expect(connected?.headers).toEqual({ "X-Key": "original" });
    } finally {
      await manager.disconnect();
    }
  });

  test("stdio cannot start without a system-isolated host transport", async () => {
    const manager = new McpManager([{ name: "unconfined", type: "stdio", command: "unused" }]);
    expect(await manager.discover()).toEqual([]);
    expect(manager.diagnostics.join("\n")).toContain("requires a system-isolated transport");
  });

  for (const format of ["json", "sse"] as const) {
    test(`SDK rejects oversized chunked HTTP ${format} before parsing a complete body`, async () => {
      let rejectedBody = false;
      const diagnostics: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: 405 });
          const rpc = (await request.json()) as RpcRequest;
          if (rpc.method === "tools/list") {
            rejectedBody = true;
            const value = JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                tools: [
                  { name: "huge", description: "x".repeat(8192), inputSchema: { type: "object" } },
                ],
              },
            });
            const payload = new TextEncoder().encode(
              format === "sse" ? `data: ${value}\n\n` : value,
            );
            let offset = 0;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (offset >= payload.length) return controller.close();
                  controller.enqueue(payload.subarray(offset, offset + 512));
                  offset += 512;
                },
              }),
              {
                headers: {
                  "content-type": format === "sse" ? "text/event-stream" : "application/json",
                },
              },
            );
          }
          const result = response(rpc);
          return result ? Response.json(result) : new Response(null, { status: 202 });
        },
      });
      const manager = new McpManager([{ name: "limited", type: "http", url: server.url.href }], {
        maxResponseBytes: 2048,
        timeoutMs: 1000,
        onDiagnostic: (text) => diagnostics.push(text),
      });
      try {
        expect(await manager.discover()).toEqual([]);
        expect(rejectedBody).toBe(true);
        expect([...manager.diagnostics, ...diagnostics].join("\n")).toContain(
          "exceeded 2048 bytes",
        );
      } finally {
        await manager.disconnect();
        server.stop(true);
      }
    });
  }

  test("discovery bounds the aggregate across individually small HTTP pages", async () => {
    let pages = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const rpc = (await request.json()) as RpcRequest;
        if (rpc.method === "tools/list") {
          pages++;
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: [
                {
                  name: `tool${pages}`,
                  description: "x".repeat(700),
                  inputSchema: { type: "object" },
                },
              ],
              nextCursor: `page${pages + 1}`,
            },
          });
        }
        const result = response(rpc);
        return result ? Response.json(result) : new Response(null, { status: 202 });
      },
    });
    const manager = new McpManager([{ name: "limited", type: "http", url: server.url.href }], {
      maxResponseBytes: 2048,
      timeoutMs: 1000,
    });
    try {
      expect(await manager.discover()).toEqual([]);
      expect(pages).toBe(3);
      expect(manager.diagnostics.join("\n")).toContain("exceeded 2048 bytes");
    } finally {
      await manager.disconnect();
      server.stop(true);
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
