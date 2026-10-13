import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { loadPlugin, PluginManager, pluginFormat } from "../src/index.ts";

const roots: string[] = [];
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vcli-formats-")));
  roots.push(root);
  return root;
}
async function put(root: string, path: string, value: unknown) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
}
async function skill(root: string, location = "skills/inspect") {
  await put(
    root,
    `${location}/SKILL.md`,
    "---\nname: inspect\ndescription: Inspect modules.\n---\nRead on demand.",
  );
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["qwen", "qoder"] as const)(
  "%s packages load shared skills and MCP without running host features",
  async (format) => {
    const root = await temp();
    const workspace = await temp();
    await put(root, pluginFormat(format).manifest, {
      name: "sample",
      version: "1.0.0",
      workflows: "workflows",
      channels: {},
      mcpServers: {
        graph: {
          command: "bun",
          args: ["${extensionPath}${pathSeparator}server.ts", "${workspacePath}"],
          cwd: "${extensionPath}",
        },
        modern: { httpUrl: "https://example.com/mcp" },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    });
    await skill(root);
    const plugin = await loadPlugin(root, { workspaceRoot: workspace });
    expect(plugin.ecosystem).toBe(format);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.servers).toHaveLength(2);
    expect(plugin.servers[0]?.args).toEqual([`${root}${sep}server.ts`, workspace]);
    expect(plugin.unsupported.join("\n")).toContain("workflows");
    expect(plugin.unsupported.join("\n")).toContain("channels");
    expect(plugin.unsupported.join("\n")).toContain("legacy SSE");
  },
);

test("multiple manifests need an explicit format, retained across installed reloads", async () => {
  const root = await temp();
  await put(root, "gemini-extension.json", { name: "sample", version: "1.0.0" });
  await put(root, "qwen-extension.json", { name: "sample", version: "2.0.0" });
  await skill(root);
  await expect(loadPlugin(root)).rejects.toThrow("Multiple plugin manifests");
  const manager = new PluginManager(await temp());
  await expect(manager.install(root)).rejects.toThrow("select --format");
  expect(await manager.list()).toEqual([]);
  expect((await manager.install(root, { format: "qwen" })).version).toBe("2.0.0");
  expect((await manager.list())[0]?.ecosystem).toBe("qwen");
  expect(await readFile(join(root, "gemini-extension.json"), "utf8")).toContain("1.0.0");
  await expect(loadPlugin(root, { format: "claude" })).rejects.toThrow("No claude plugin manifest");
});

test("Qwen url retains legacy transport meaning", async () => {
  const root = await temp();
  await put(root, "qwen-extension.json", {
    name: "sample",
    mcpServers: { legacy: { url: "https://example.com/sse" } },
  });
  const plugin = await loadPlugin(root);
  expect(plugin.servers).toEqual([]);
  expect(plugin.unsupported.join("\n")).toContain("qwen url uses legacy SSE");
});

test("malformed vendor MCP fields disable only that server without coercion", async () => {
  const root = await temp();
  await put(root, ".claude-plugin/plugin.json", {
    name: "sample",
    mcpServers: {
      good: { command: "bun" },
      type: { type: false, command: "bun" },
      cwd: { command: "bun", cwd: 123 },
      url: { url: 123, command: "bun" },
      mixed: { command: "bun", url: "https://example.com/mcp" },
      urls: { url: "https://example.com/mcp", httpUrl: "https://example.org/mcp" },
      variable: { httpUrl: "https://example.com/${user_config.token}" },
    },
  });
  const plugin = await loadPlugin(root);
  expect(plugin.servers.map((s) => s.name)).toEqual(["sample.good"]);
  expect(plugin.unsupported).toHaveLength(6);
});

test("marketplace manifest components are durable and package authority is enforced", async () => {
  const root = await temp();
  await skill(root, "extra/inspect");
  await put(root, "marketplace.json", {
    plugins: [
      {
        name: "entry",
        source: "./bundle",
        strict: false,
        skills: "./extra",
        mcpServers: { graph: { command: "bun" } },
        hooks: {},
      },
    ],
  });
  await mkdir(join(root, "bundle"), { recursive: true });
  await skill(join(root, "bundle"), "extra/inspect");
  const manager = new PluginManager(await temp());
  await manager.addMarketplace("local", root);
  const installed = await manager.installFromMarketplace("local", "entry");
  expect(installed.ecosystem).toBe("claude");
  expect(installed.skills).toHaveLength(1);
  expect(installed.servers.map((s) => s.name)).toEqual(["entry.graph"]);
  expect((await manager.list())[0]?.skills).toHaveLength(1);
  expect(installed.unsupported.join("\n")).toContain("hooks");
  await put(root, ".claude-plugin/plugin.json", {
    name: "entry",
    mcpServers: { native: { command: "bun" } },
  });
  await expect(
    loadPlugin(root, {
      marketplaceManifest: { name: "entry", skills: "extra" },
      marketplaceStrict: false,
    }),
  ).rejects.toThrow("Conflicting manifests");
  const merged = await loadPlugin(root, {
    marketplaceManifest: {
      name: "entry",
      skills: "extra",
      mcpServers: { ignored: { command: "bun" } },
    },
  });
  expect(merged.skills).toHaveLength(1);
  expect(merged.servers.map((s) => s.name)).toEqual(["entry.native"]);
  expect(merged.unsupported.join("\n")).toContain("authoritative");
});

test("damaged installed plugins are disabled independently and recover after repair", async () => {
  const root = await temp();
  const healthy = await temp();
  const state = await temp();
  await put(root, "qwen-extension.json", { name: "broken", version: "1.0.0" });
  await put(healthy, "gemini-extension.json", { name: "healthy", version: "1.0.0" });
  await skill(root);
  await skill(healthy);
  const manager = new PluginManager(state);
  await manager.install(root);
  await manager.install(healthy);
  await put(state, "plugins/broken/qwen-extension.json", "invalid json");
  let plugins = await manager.list();
  expect(plugins.find((p) => p.name === "broken")).toMatchObject({
    disabled: true,
    skills: [],
    servers: [],
    ecosystem: "qwen",
  });
  expect(plugins.find((p) => p.name === "broken")?.unsupported.join("\n")).toContain(
    "Plugin disabled",
  );
  expect(plugins.find((p) => p.name === "healthy")?.skills).toHaveLength(1);
  await put(state, "plugins/broken/qwen-extension.json", { name: "other" });
  expect((await manager.list()).find((p) => p.name === "broken")?.unsupported.join("\n")).toContain(
    "identity changed",
  );
  await put(state, "plugins/broken/qwen-extension.json", { name: "broken" });
  plugins = await manager.list();
  expect(plugins.find((p) => p.name === "broken")?.disabled).toBeUndefined();
  expect(plugins.find((p) => p.name === "broken")?.skills).toHaveLength(1);
});

test("invalid component declarations and ignored catalog features stay visible", async () => {
  const root = await temp();
  await put(root, ".claude-plugin/plugin.json", {
    name: "sample",
    skills: 42,
    mcpServers: [false],
  });
  await skill(root);
  await put(root, ".mcp.json", {
    mcpServers: {
      working: { command: "bun" },
      invalid: { url: "https://example.com/mcp", headers: null },
    },
  });
  const plugin = await loadPlugin(root, {
    marketplaceManifest: {
      name: "sample",
      dependencies: ["required"],
      userConfig: {},
      lspServers: {},
    },
  });
  expect(plugin.skills).toHaveLength(1);
  expect(plugin.servers.map((s) => s.name)).toEqual(["sample.working"]);
  expect(plugin.unsupported.join("\n")).toContain("Skill declaration");
  expect(plugin.unsupported.join("\n")).toContain("MCP declaration");
  expect(plugin.unsupported.join("\n")).toContain("Marketplace dependencies ignored");
  expect(plugin.unsupported.join("\n")).toContain("Marketplace userConfig ignored");
  expect(plugin.unsupported.join("\n")).toContain("Marketplace lspServers ignored");
});

test("snapshot listing holds the manager queue until metadata reads finish", async () => {
  const root = await temp();
  await put(root, "qwen-extension.json", { name: "sample" });
  const manager = new PluginManager(await temp());
  await manager.install(root);
  const internal = manager as unknown as { state: () => Promise<unknown> };
  const readState = internal.state.bind(manager);
  let started!: () => void;
  let finish!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  internal.state = async () => {
    if (++reads === 1) {
      started();
      await gate;
    }
    return readState();
  };
  const listing = manager.list();
  await starting;
  const removal = manager.remove("sample");
  await Promise.resolve();
  expect(reads).toBe(1);
  finish();
  expect((await listing)[0]?.disabled).toBeUndefined();
  await removal;
  expect(await manager.list()).toEqual([]);
});

test("removing a native catalog package manifest cannot change format or activate rejected MCP", async () => {
  const root = await temp();
  const state = await temp();
  await put(root, "marketplace.json", { plugins: [{ name: "sample", source: "./bundle" }] });
  await put(root, "bundle/qwen-extension.json", { name: "sample" });
  await put(root, "bundle/.mcp.json", {
    mcpServers: { remote: { url: "https://example.com/sse" } },
  });
  const manager = new PluginManager(state);
  await manager.addMarketplace("local", root);
  expect((await manager.installFromMarketplace("local", "sample")).servers).toEqual([]);
  await rm(join(state, "plugins/sample/qwen-extension.json"));
  const plugin = (await new PluginManager(state).list())[0]!;
  expect(plugin).toMatchObject({ ecosystem: "qwen", disabled: true, skills: [], servers: [] });
  expect(plugin.unsupported.join("\n")).toContain("manifest is missing");
});
