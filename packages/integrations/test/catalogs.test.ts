import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readMarketplaceCatalog } from "../src/catalogs.ts";

const temporary: string[] = [];
async function catalog(
  plugins: unknown[],
  path = ".claude-plugin/marketplace.json",
  metadata?: unknown,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vcli-catalogs-"));
  temporary.push(root);
  await mkdir(join(root, "plugins/sample"), { recursive: true });
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify({ plugins, metadata }));
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("marketplace catalog source normalization", () => {
  test.each([
    ".claude-plugin/marketplace.json",
    ".codex-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "marketplace.json",
  ])("reads %s without fetching sources", async (path) => {
    const result = await readMarketplaceCatalog(
      await catalog([{ name: "sample", source: "./plugins/sample" }], path),
    );
    expect(result.plugins[0]?.source).toBe("./plugins/sample");
    expect(result.plugins[0]?.local).toBe(true);
    expect(result.unsupported).toEqual([]);
  });

  test("normalizes documented repository objects and legacy aliases", async () => {
    const sources = [
      { source: "github", repo: "acme/sample" },
      { source: "url", url: "https://gitlab.example/acme/sample" },
      { source: "git-subdir", url: "acme/monorepo", path: "packages/sample", ref: "release/1.0" },
      { source: "git", url: "ssh://git@example.com/acme/sample.git", path: "plugin" },
      { type: "repository", url: "git@example.com:acme/sample.git" },
      { source: "directory", path: "./plugins/sample" },
      { source: "local", path: "./plugins/sample" },
    ];
    const result = await readMarketplaceCatalog(
      await catalog(sources.map((source, index) => ({ name: `sample-${index}`, source }))),
    );
    expect(result.unsupported).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.source)).toEqual([
      "https://github.com/acme/sample.git",
      "https://gitlab.example/acme/sample",
      "https://github.com/acme/monorepo.git",
      "ssh://git@example.com/acme/sample.git",
      "git@example.com:acme/sample.git",
      "./plugins/sample",
      "./plugins/sample",
    ]);
    expect(result.plugins[2]?.subdir).toBe("packages/sample");
    expect(result.plugins[2]?.revision).toBe("release/1.0");
    expect(result.plugins[3]?.subdir).toBe("plugin");
  });

  test("pins full commits while validating lower-priority refs", async () => {
    const result = await readMarketplaceCatalog(
      await catalog([
        {
          name: "sha1",
          source: { source: "github", repo: "acme/sample", sha: "a".repeat(40), ref: "main" },
        },
        { name: "sha256", source: { source: "github", repo: "acme/sample", sha: "B".repeat(64) } },
        {
          name: "invalid-ref",
          source: { source: "github", repo: "acme/sample", sha: "a".repeat(40), ref: 1 },
        },
      ]),
    );
    expect(result.plugins.map((plugin) => plugin.revision)).toEqual([
      "a".repeat(40),
      "B".repeat(64),
    ]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toContain("invalid-ref");
  });

  test("reports unsupported and malformed entries independently", async () => {
    const invalid: unknown[] = [
      { source: "npm", package: "sample" },
      { source: "archive", url: "https://example.com/sample.zip" },
      { source: "command", command: "produce-plugin" },
      { source: "url", url: "./plugins/sample" },
      { source: "url", url: "https://" },
      { source: "git-subdir", url: "acme/sample" },
      { source: "git-subdir", url: "acme/sample", path: "../escape" },
      { source: "github", repo: "acme/sample", sha: "main" },
      { source: "github", repo: "acme/sample", ref: "main..bad" },
      { source: "github", repo: "acme/sample", revision: false },
      { source: "github", repo: "acme/sample", path: 4 },
      { source: "github", repo: "acme/sample", subdir: [] },
    ];
    const root = await catalog([
      ...invalid.map((source, index) => ({ name: `invalid-${index}`, source })),
      { name: "bad-revision", source: "./plugins/sample", revision: 1 },
      { name: "bad-subdir", source: "./plugins/sample", subdir: false },
      { name: "bad-strict", source: "./plugins/sample", strict: "false" },
      { name: "sample", source: "./plugins/sample" },
    ]);
    const result = await readMarketplaceCatalog(root);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["sample"]);
    expect(result.unsupported).toHaveLength(invalid.length + 3);
    for (let index = 0; index < invalid.length; index++)
      expect(result.unsupported[index]).toContain(`invalid-${index}`);
  });

  test("disables every duplicate even when one source is malformed", async () => {
    const result = await readMarketplaceCatalog(
      await catalog([
        { name: "sample", source: "./plugins/sample" },
        { name: "sample", source: null },
        { name: "other", source: null },
        { name: "other", source: "./plugins/sample" },
        { name: "unique", source: "./plugins/sample" },
      ]),
    );
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["unique"]);
    expect(
      result.unsupported.filter((diagnostic) => diagnostic.includes("Duplicate")),
    ).toHaveLength(2);
  });

  test("resolves pluginRoot bare names and explicit root sources", async () => {
    const result = await readMarketplaceCatalog(
      await catalog(
        [
          { name: "sample", source: "sample" },
          { name: "root", source: "." },
          { name: "explicit", source: "./plugins/sample" },
        ],
        "marketplace.json",
        { pluginRoot: "./plugins" },
      ),
    );
    expect(result.unsupported).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.source)).toEqual([
      "./plugins/sample",
      ".",
      "./plugins/sample",
    ]);
  });

  test("rejects pluginRoot traversal, invalid types, and escaping symlinks", async () => {
    for (const pluginRoot of ["../outside", 12]) {
      const result = await readMarketplaceCatalog(
        await catalog([{ name: "sample", source: "sample" }], "marketplace.json", { pluginRoot }),
      );
      expect(result.plugins).toEqual([]);
      expect(result.unsupported).toHaveLength(1);
    }
    const outside = await catalog([]);
    const root = await catalog([{ name: "escape", source: "./escape" }]);
    await symlink(outside, join(root, "escape"));
    const result = await readMarketplaceCatalog(root);
    expect(result.plugins).toEqual([]);
    expect(result.unsupported[0]).toContain("Symlink escapes");
  });

  test("preserves manifest declarations and strict policy for the plugin loader", async () => {
    const result = await readMarketplaceCatalog(
      await catalog([
        {
          name: "sample",
          source: "./plugins/sample",
          strict: false,
          version: "1.0.0",
          skills: ["./extra"],
          mcpServers: { sample: { command: "bun" } },
          hooks: "./hooks.json",
          dependencies: ["other"],
          category: "ignored display field",
        },
      ]),
    );
    expect(result.unsupported).toEqual([]);
    expect(result.plugins[0]?.strict).toBe(false);
    expect(result.plugins[0]?.manifest).toEqual({
      name: "sample",
      version: "1.0.0",
      skills: ["./extra"],
      mcpServers: { sample: { command: "bun" } },
      hooks: "./hooks.json",
      dependencies: ["other"],
    });
  });
});
