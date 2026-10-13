import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@vcli/core";
import { findCycles, graphRevision } from "./graph.ts";
import { inventory, JS_SOURCE } from "./scan-inventory.ts";
import { readPackages } from "./scan-packages.ts";
import { resolveImports } from "./scan-resolution.ts";
import { collectSyntaxFacts, loadCache, persistCache } from "./scan-syntax.ts";
import { compare, hash } from "./utils.ts";

export async function scan(rootPath: string): Promise<ArchitectureGraph> {
  const started = performance.now();
  const root = resolve(rootPath);
  if (!(await stat(root)).isDirectory())
    throw new Error(`Architecture root is not a directory: ${root}`);
  const diagnostics: string[] = [];
  const paths = await inventory(root, diagnostics);
  const previousCache = await loadCache(root, diagnostics);
  const packages = await readPackages(root, paths, diagnostics);
  const syntax = await collectSyntaxFacts(root, paths, previousCache, diagnostics);
  const nodes: ArchitectureNode[] = [...packages.nodes];
  const edges: ArchitectureEdge[] = packages.nodes
    .filter((node) => node.parent)
    .map((node) => ({
      id: `contains:${node.parent}->${node.id}`,
      source: node.parent!,
      target: node.id,
      kind: "contains",
      status: "observed",
    }));
  for (const [path, facts] of syntax.files) {
    const node: ArchitectureNode = {
      id: `${JS_SOURCE.test(path) ? "module" : "file"}:${path}`,
      label: path,
      kind: JS_SOURCE.test(path) ? "module" : "file",
      path,
      parent: packages.owner(path)?.id,
      signatures: facts.signatures,
      evidence: [{ path, line: 1, endLine: syntax.lineCounts.get(path)! }],
      status: "observed",
    };
    nodes.push(node);
    if (node.parent)
      edges.push({
        id: `contains:${node.parent}->${node.id}`,
        source: node.parent,
        target: node.id,
        kind: "contains",
        status: "observed",
      });
  }
  const options = resolveImports(
    root,
    syntax.files,
    packages,
    new Set(paths),
    nodes,
    edges,
    diagnostics,
  );
  nodes.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(a.id, b.id));
  if (JSON.stringify(previousCache) !== JSON.stringify(syntax.cache))
    await persistCache(syntax.cache, diagnostics);
  const salt = JSON.stringify({
    files: Object.entries(syntax.cache.files).map(([path, record]) => [path, record.hash]),
    manifests: packages.manifests.map((manifest) => [manifest.path, hash(manifest.text)]),
    options,
  });
  return {
    root,
    revision: graphRevision(nodes, edges, salt),
    nodes,
    edges,
    diagnostics: [...new Set(diagnostics)].sort(compare),
    cycles: findCycles(nodes, edges),
    stats: {
      files: syntax.files.size,
      parsed: syntax.parsed,
      cached: syntax.cached,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}
