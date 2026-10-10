import type { ArchitectureGraph } from "./contracts.ts";

export function diffGraph(before: ArchitectureGraph, after: ArchitectureGraph): ArchitectureGraph {
  const oldNodes = new Map(before.nodes.map(n => [n.id, n])); const newNodes = new Set(after.nodes.map(n => n.id));
  const oldEdges = new Map(before.edges.map(e => [e.id, e])); const newEdges = new Set(after.edges.map(e => e.id));
  return { ...after,
    nodes: [...after.nodes.map(n => ({ ...n, change: !oldNodes.has(n.id) ? "added" as const : JSON.stringify(oldNodes.get(n.id)) !== JSON.stringify(n) ? "modified" as const : undefined })), ...before.nodes.filter(n => !newNodes.has(n.id)).map(n => ({ ...n, change: "removed" as const }))],
    edges: [...after.edges.map(e => ({ ...e, change: !oldEdges.has(e.id) ? "added" as const : JSON.stringify(oldEdges.get(e.id)) !== JSON.stringify(e) ? "modified" as const : undefined })), ...before.edges.filter(e => !newEdges.has(e.id)).map(e => ({ ...e, change: "removed" as const }))],
  };
}
