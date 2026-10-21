import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import { loadConfig } from "../apps/cli/src/config.ts";
import { createHarness } from "../apps/cli/src/harness.ts";
import { inspectWorkspace } from "../apps/cli/src/workspace-inspection.ts";

let directory: string;
let root: string;
let home: string;
let previousHome: string | undefined;
const cli = join(import.meta.dir, "../apps/cli/src/index.ts");
const credential = "dummy-plugin-private-value";

beforeEach(async () => {
  previousHome = process.env.VCLI_CONFIG_HOME;
  directory = await mkdtemp(join(tmpdir(), "vcli-plugin-command-"));
  root = join(directory, "project");
  home = join(directory, "home");
  await mkdir(root);
  await mkdir(home);
  process.env.VCLI_CONFIG_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.VCLI_CONFIG_HOME;
  else process.env.VCLI_CONFIG_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
});

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

async function command(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, "plugins", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      VCLI_CONFIG_HOME: home,
      VCLI_PLUGIN_TEST_SECRET: credential,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("plugin CLI metadata and runtime wiring", () => {
  test("formats and preinstall inspection need no installation or provider", async () => {
    const formats = await command("formats");
    expect(formats.exitCode).toBe(0);
    expect(JSON.parse(formats.stdout).map((format: { id: string }) => format.id)).toEqual([
      "portable",
      "claude",
      "codex",
      "gemini",
      "qwen",
      "qoder",
    ]);
    const source = join(directory, "inspect-sample");
    await put(join(source, ".claude-plugin/plugin.json"), {
      name: "sample",
      hooks: { ignored: true },
      mcpServers: {
        worker: {
          command: "never-launch-inspect-fixture",
          args: ["${VCLI_PLUGIN_TEST_SECRET}"],
          env: { PRIVATE: "${VCLI_PLUGIN_TEST_SECRET}" },
        },
      },
    });
    await put(join(source, "qwen-extension.json"), { name: "qwen-sample" });
    const ambiguous = await command("inspect", source);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("Multiple plugin manifests found");
    const inspection = await command("inspect", source, "--format", "claude");
    expect(inspection.exitCode).toBe(0);
    const inspected = JSON.parse(inspection.stdout);
    expect(inspected).toMatchObject({
      name: "sample",
      ecosystem: "claude",
      servers: [],
    });
    expect(inspected.unsupported).toContain("claude hooks is unsupported");
    expect(inspected.unsupported.join("\n")).toContain(
      "ambient environment variable VCLI_PLUGIN_TEST_SECRET is unsupported",
    );
    expect(inspection.stdout).not.toContain(credential);
    expect(inspection.stdout).not.toContain("never-launch-inspect-fixture");
    for (const key of ["source", "command", "args", "env", "headers", "url"])
      expect(inspection.stdout).not.toContain(`"${key}":`);
    expect(JSON.parse((await command("list")).stdout)).toEqual([]);
  });

  test("explicit format persists and install/list omit executable configuration and credentials", async () => {
    const source = join(directory, "multi-format");
    await put(join(source, ".claude-plugin/plugin.json"), { name: "wrong-format" });
    await put(join(source, "qwen-extension.json"), {
      name: "qwen-sample",
      version: "1.0.0",
      mcpServers: {
        worker: {
          command: "never-launch-plugin-fixture",
          args: [credential],
          env: { PRIVATE: credential },
        },
        remote: {
          httpUrl: `https://example.test/mcp?key=${credential}`,
          headers: { Authorization: `Bearer ${credential}` },
        },
      },
    });
    const installed = await command("install", source, "--format", "qwen");
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      name: "qwen-sample",
      ecosystem: "qwen",
      servers: [
        { name: "qwen-sample.remote", type: "http" },
        { name: "qwen-sample.worker", type: "stdio" },
      ],
    });
    const listed = await command("list");
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)[0].ecosystem).toBe("qwen");
    for (const result of [installed, listed]) {
      expect(result.stdout).not.toContain(credential);
      expect(result.stdout).not.toContain("never-launch-plugin-fixture");
      for (const key of ["source", "command", "args", "env", "headers", "url"])
        expect(result.stdout).not.toContain(`"${key}":`);
    }
  });

  test("invalid explicit formats fail before installing a package", async () => {
    const source = join(directory, "sample");
    await put(join(source, ".claude-plugin/plugin.json"), { name: "sample" });
    const result = await command("install", source, "--format", "unrecognized");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown plugin format");
    expect(JSON.parse((await command("list")).stdout)).toEqual([]);
  });

  test("marketplace responses expose summaries without embedded MCP configuration", async () => {
    const source = join(directory, "catalog");
    await put(join(source, "vendor/.claude-plugin/plugin.json"), { name: "sample" });
    await put(join(source, ".claude-plugin/marketplace.json"), {
      name: "catalog",
      owner: { name: "Fixture" },
      plugins: [
        {
          name: "sample",
          description: "Sample metadata",
          source: "./vendor",
          mcpServers: {
            worker: { command: "never-launch-catalog-fixture", args: [credential] },
          },
        },
      ],
    });
    for (const args of [
      ["marketplace", "add", "catalog", source],
      ["marketplace", "list"],
      ["marketplace", "refresh", "catalog"],
    ]) {
      const result = await command(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Sample metadata");
      expect(result.stdout).not.toContain(credential);
      expect(result.stdout).not.toContain("never-launch-catalog-fixture");
      for (const key of ["source", "manifest", "mcpServers", "args", "env", "headers"])
        expect(result.stdout).not.toContain(`"${key}":`);
    }
  });

  test("inspection and harness expose unsupported reasons, Qwen skills and one MCP namespace", async () => {
    const source = join(directory, "sample");
    await put(join(source, ".claude-plugin/plugin.json"), {
      name: "sample",
      hooks: { ignored: true },
      mcpServers: {
        worker: { command: "never-launch-harness-fixture", cwd: "${workspacePath}" },
      },
    });
    await put(
      join(root, ".qwen/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review a change\n---\nReview instructions.\n",
    );
    expect((await command("install", source)).exitCode).toBe(0);
    expect(await inspectWorkspace(root, "plugins")).toContain("claude hooks is unsupported");
    expect(await inspectWorkspace(root, "skills")).toContain("project:review");

    let approval: Record<string, unknown> | undefined;
    const config = {
      ...(await loadConfig(root)),
      provider: "compatible" as const,
      model: "offline-fixture",
      baseURL: "http://localhost:1",
      permission: "ask" as const,
    };
    const harness = await createHarness(
      root,
      config,
      createArchitectureService(),
      undefined,
      async (_tool, args) => {
        approval = args;
        return false;
      },
      { apiKey: "offline-fixture-key" },
    );
    try {
      expect(harness.diagnostics).toContain("Plugin sample: claude hooks is unsupported");
      await expect(
        harness.registry.execute(
          { id: "discover", name: "tools_search", arguments: { query: "review" } },
          { root, signal: new AbortController().signal, sessionId: "fixture" },
        ),
      ).rejects.toThrow();
      expect(approval).toEqual({
        servers: [
          { name: "sample.worker", type: "stdio", command: "never-launch-harness-fixture" },
        ],
      });
    } finally {
      await harness.close();
    }
  });
});
