import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArchitectureDesign, ArchitectureGraph } from "@vcli/core";
import {
  ArchitectureDesignError,
  createArchitectureService,
  hitTest,
  layoutGraph,
  rasterize,
  renderSvg,
  sceneToViewport,
  validateDesign,
  viewportToScene,
} from "../src/index.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vcli-architecture-test-"));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const config = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    baseUrl: ".",
    paths: { "@app/*": ["src/*"] },
  },
};
const sourceFiles = {
  "package.json": JSON.stringify({ name: "example", workspaces: ["packages/*"] }),
  "tsconfig.json": JSON.stringify(config),
  "src/main.ts":
    'import type { Shared } from "@app/helper";\nexport { helper } from "./helper.js";\nimport { client } from "@workspace/client";\nexport function run(x: Shared): string { return client(); }\n',
  "src/helper.ts":
    'export interface Shared { value: string }\nexport function helper(): string { return "ok"; }\n',
  "src/a.ts": 'import { b } from "@app/b"; export const a = () => b;\n',
  "src/b.ts": 'import { a } from "./a.js"; export const b = () => a;\n',
  "packages/client/package.json": JSON.stringify({
    name: "@workspace/client",
    exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } },
  }),
  "packages/client/src/index.ts": 'export const client = (): string => "client";\n',
};

describe("source architecture", () => {
  test("resolves aliases, ESM reexports, workspaces, signatures and cycles from evidence", async () => {
    const root = await project(sourceFiles),
      service = createArchitectureService();
    const graph = await service.scan(root);
    expect(graph.diagnostics).toEqual([]);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "module:src/main.ts" &&
          e.target === "module:src/helper.ts" &&
          e.kind === "type-import" &&
          e.evidence?.[0]?.line === 1,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "module:src/main.ts" &&
          e.target === "module:src/helper.ts" &&
          e.kind === "reexport" &&
          e.evidence?.[0]?.line === 2,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "module:src/main.ts" && e.target === "module:packages/client/src/index.ts",
      ),
    ).toBe(true);
    expect(graph.nodes.find((n) => n.id === "module:src/main.ts")?.signatures).toContain(
      "export function run(x: Shared): string",
    );
    expect(graph.cycles).toEqual([["module:src/a.ts", "module:src/b.ts"]]);
    expect(graph.stats.parsed).toBe(5);
    const warm = await createArchitectureService().scan(root);
    expect(warm.revision).toBe(graph.revision);
    expect(warm.stats.parsed).toBe(0);
    expect(warm.stats.cached).toBe(5);
  });

  test("invalidates a changed file by content, including same-length edits", async () => {
    const root = await project(sourceFiles),
      service = createArchitectureService();
    const initial = await service.scan(root);
    await writeFile(
      join(root, "src/helper.ts"),
      sourceFiles["src/helper.ts"].replace("helper", "better"),
    );
    const updated = await service.scan(root);
    expect(updated.stats.parsed).toBe(1);
    expect(updated.stats.cached).toBe(4);
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.nodes.find((n) => n.id === "module:src/helper.ts")?.signatures).toContain(
      "export function better(): string",
    );
  });

  test("re-resolves changed aliases while cached syntax remains reusable", async () => {
    const root = await project({
        ...sourceFiles,
        "other/helper.ts": "export interface Shared { other: string }",
      }),
      service = createArchitectureService();
    await service.scan(root);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        ...config,
        compilerOptions: { ...config.compilerOptions, paths: { "@app/*": ["other/*"] } },
      }),
    );
    const changed = await service.scan(root);
    expect(changed.stats.parsed).toBe(0);
    expect(
      changed.edges.some(
        (e) =>
          e.source === "module:src/main.ts" &&
          e.kind === "type-import" &&
          e.target === "module:other/helper.ts",
      ),
    ).toBe(true);
    expect(changed.diagnostics.some((d) => d.includes('"@app/b"'))).toBe(true);
  });

  test("deleted files disappear from graph and cache and turn dangling imports into diagnostics", async () => {
    const root = await project(sourceFiles),
      service = createArchitectureService();
    await service.scan(root);
    await unlink(join(root, "src/helper.ts"));
    const graph = await service.scan(root);
    expect(graph.nodes.some((n) => n.id === "module:src/helper.ts")).toBe(false);
    expect(graph.diagnostics.some((d) => d.includes('"./helper.js"'))).toBe(true);
    expect(
      graph.edges.some((e) => e.source === "module:src/main.ts" && e.status === "unresolved"),
    ).toBe(true);
    const cache = JSON.parse(
      await readFile(join(root, ".vcli/state/architecture-index.json"), "utf8"),
    );
    expect(cache.files["src/helper.ts"]).toBeUndefined();
  });

  test("honors ignored paths, represents other-language files and resolves real assets", async () => {
    const root = await project({
      ".gitignore": "ignored.ts\ngenerated/\n",
      "main.ts":
        'import asset from "./logo.svg"; import fs from "node:fs"; export const logo = asset;',
      "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "worker.py": "def run(): return 1",
      "ignored.ts": "export const nope = 1",
      "generated/g.ts": "export const nope = 2",
      "node_modules/vendor/index.ts": "export const nope = 3",
    });
    const graph = await createArchitectureService().scan(root);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.nodes.some((n) => n.id === "file:worker.py")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "file:logo.svg")).toBe(true);
    expect(
      graph.nodes.some(
        (n) =>
          n.label.includes("ignored") ||
          n.label.includes("generated") ||
          n.label.includes("vendor"),
      ),
    ).toBe(false);
  });

  test("supports nested configs with extends and reports malformed source without inventing edges", async () => {
    const root = await project({
      "base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@shared": ["shared.ts"] } },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./base.json",
        compilerOptions: { moduleResolution: "Bundler", module: "ESNext" },
      }),
      "shared.ts": "export type Shared = string;",
      "nested/main.ts": 'export type { Shared } from "@shared";',
      "broken.ts": "export const broken = ;",
    });
    const graph = await createArchitectureService().scan(root);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "module:nested/main.ts" &&
          e.target === "module:shared.ts" &&
          e.kind === "type-import",
      ),
    ).toBe(true);
    expect(graph.diagnostics.some((d) => d.startsWith("broken.ts:"))).toBe(true);
  });

  test("a corrupt cache rebuilds safely", async () => {
    const root = await project({
      "main.ts": "export const value = 1",
      ".vcli/state/architecture-index.json": "broken cache",
    });
    const graph = await createArchitectureService().scan(root);
    expect(graph.stats.parsed).toBe(1);
    expect(graph.diagnostics).toContain(
      "Architecture index could not be read; rebuilding it from source",
    );
    expect((await createArchitectureService().scan(root)).stats.parsed).toBe(0);
  });
});

describe("intended architecture and drift", () => {
  const design: ArchitectureDesign = {
    version: 1,
    components: [
      {
        id: "app",
        label: "Application",
        paths: ["src/**"],
        dependencies: ["client"],
        forbiddenDependencies: ["client"],
      },
      { id: "client", label: "Client", paths: ["packages/client/src/**"], dependencies: [] },
      { id: "future", label: "Future", paths: ["future/**"] },
    ],
    decisions: ["Keep client access behind a port"],
  };
  test("roundtrips versioned designs and marks intended modules as planned", async () => {
    const root = await project({}),
      service = createArchitectureService();
    expect((await service.readDesign(root)).components).toEqual([]);
    await service.writeDesign(root, design);
    expect(await service.readDesign(root)).toEqual(design);
    const intended = service.intendedGraph(root, design);
    expect(intended.nodes.every((n) => n.status === "planned")).toBe(true);
    expect(intended.edges[0]?.target).toBe("component:client");
  });
  test("forbidden relationships override allowlists and carry exact source evidence", async () => {
    const root = await project({ ...sourceFiles, "other.py": "pass" }),
      service = createArchitectureService();
    const graph = await service.scan(root),
      drift = service.check(graph, design);
    expect(drift.find((d) => d.kind === "forbidden-dependency")?.evidence).toEqual([
      { path: "src/main.ts", line: 3, endLine: 3 },
    ]);
    expect(drift.some((d) => d.kind === "missing-component" && d.message.includes("Future"))).toBe(
      true,
    );
    expect(drift.some((d) => d.kind === "unmapped-module" && d.message.includes("other.py"))).toBe(
      true,
    );
    expect(service.check(graph, { version: 1, components: [], decisions: [] })).toEqual([]);
  });
  test("the most specific boundary wins and omitted dependency lists allow cross-component imports", async () => {
    const root = await project({
        "src/ui/a.ts": 'import { b } from "../b"',
        "src/b.ts": "export const b = 1",
      }),
      service = createArchitectureService();
    const graph = await service.scan(root);
    const nested: ArchitectureDesign = {
      version: 1,
      components: [
        { id: "src", label: "Source", paths: ["src/**"] },
        { id: "ui", label: "UI", paths: ["src/ui/**"], dependencies: [] },
      ],
      decisions: [],
    };
    expect(
      service.check(graph, nested).find((d) => d.kind === "forbidden-dependency")?.message,
    ).toContain("UI depends on Source");
    delete nested.components[1]!.dependencies;
    expect(service.check(graph, nested)).toEqual([]);
  });
  test("rejects invalid versions, duplicate components, unknown boundaries and escaping paths", () => {
    expect(() => validateDesign({ ...design, version: 2 })).toThrow(ArchitectureDesignError);
    expect(() =>
      validateDesign({ ...design, components: [design.components[0], design.components[0]] }),
    ).toThrow("duplicate");
    expect(() =>
      validateDesign({ ...design, components: [{ id: "a", label: "A", paths: ["../outside"] }] }),
    ).toThrow("relative");
    expect(() =>
      validateDesign({
        ...design,
        components: [{ id: "a", label: "A", paths: ["src"], dependencies: ["unknown"] }],
      }),
    ).toThrow("unknown");
  });
});

function sampleGraph(): ArchitectureGraph {
  return {
    root: "/example",
    revision: "sample",
    diagnostics: [],
    cycles: [],
    stats: { files: 2, parsed: 2, cached: 0, durationMs: 0 },
    nodes: [
      { id: "module:a", label: "api.ts", kind: "module", path: "src/api.ts", status: "observed" },
      {
        id: "module:b",
        label: "store.ts",
        kind: "module",
        path: "src/store.ts",
        status: "observed",
      },
    ],
    edges: [
      {
        id: "a-b",
        source: "module:a",
        target: "module:b",
        kind: "import",
        evidence: [{ path: "src/api.ts", line: 1 }],
      },
    ],
  };
}

describe("real architecture rendering", () => {
  test("layout and routed edges are deterministic independent of input order", async () => {
    const graph = sampleGraph(),
      first = await layoutGraph(graph);
    graph.nodes.reverse();
    graph.edges.reverse();
    const second = await layoutGraph(graph);
    expect(second).toEqual(first);
    expect(first.edges[0]!.points.length).toBeGreaterThanOrEqual(2);
    expect(first.nodes[0]!.x + first.nodes[0]!.width).toBeLessThan(first.nodes[1]!.x);
  });
  test("groups large graphs without dropping dependency evidence and keeps a strict node cap", async () => {
    const graph = sampleGraph();
    graph.nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `m:${i}`,
      kind: "module",
      path: `src/${i % 12}/m${i}.ts`,
      label: `m${i}.ts`,
      status: "observed",
    }));
    graph.edges = [
      {
        id: "dep",
        source: "m:0",
        target: "m:1",
        kind: "import",
        evidence: [{ path: "src/0/m0.ts", line: 1 }],
      },
    ];
    const scene = await layoutGraph(graph, { maxNodes: 8 });
    expect(scene.nodes.length).toBe(8);
    expect(scene.nodes.flatMap((n) => n.memberIds ?? []).length).toBe(120);
    expect(scene.edges[0]?.evidence?.[0]?.line).toBe(1);
    expect(scene.omittedNodes).toBe(112);
  });
  test("hit tests agree with pan/zoom transformations", async () => {
    const scene = await layoutGraph(sampleGraph()),
      node = scene.nodes[0]!;
    const point = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    const viewport = { x: 10, y: 20, zoom: 1.5, width: 800, height: 400 };
    expect(hitTest(scene, viewportToScene(sceneToViewport(point, viewport), viewport))?.id).toBe(
      node.id,
    );
    expect(hitTest(scene, { x: -1, y: -1 })).toBeUndefined();
    expect(() => sceneToViewport(point, { ...viewport, zoom: 0 })).toThrow("positive zoom");
  });
  test("SVG escapes labels, exposes change cues and PNG uses the bundled font reproducibly", async () => {
    const graph = sampleGraph();
    graph.nodes[0]!.label = '<api & "server">';
    graph.nodes[0]!.change = "added";
    graph.nodes[1]!.change = "removed";
    graph.edges[0]!.change = "removed";
    const scene = await layoutGraph(graph),
      svg = renderSvg(scene);
    expect(svg).toContain("&lt;api &amp; &quot;server&quot;&gt;");
    expect(svg).toContain("#4ade80");
    expect(svg).toContain("#f87171");
    expect(svg).toContain('stroke-dasharray="5 4"');
    const png = rasterize(svg);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBeGreaterThan(1000);
    expect(createHash("sha256").update(rasterize(svg)).digest("hex")).toBe(
      createHash("sha256").update(png).digest("hex"),
    );
  });
});
