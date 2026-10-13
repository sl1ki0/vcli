import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@vcli/core";
import { compare, hash } from "./utils.ts";

/** Strongly connected components, including self imports; output order is stable. */
export function findCycles(nodes: ArchitectureNode[], edges: ArchitectureEdge[]): string[][] {
  const ids = new Set(
    nodes.filter((n) => n.kind === "module" || n.kind === "component").map((n) => n.id),
  );
  const adjacent = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (edge.kind !== "contains" && ids.has(edge.source) && ids.has(edge.target))
      adjacent.get(edge.source)!.push(edge.target);
  }
  for (const values of adjacent.values()) values.sort(compare);
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;
  function visit(id: string) {
    indices.set(id, next);
    low.set(id, next++);
    stack.push(id);
    active.add(id);
    for (const child of adjacent.get(id)!) {
      if (!indices.has(child)) {
        visit(child);
        low.set(id, Math.min(low.get(id)!, low.get(child)!));
      } else if (active.has(child)) low.set(id, Math.min(low.get(id)!, indices.get(child)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let item: string;
      do {
        item = stack.pop()!;
        active.delete(item);
        component.push(item);
      } while (item !== id);
      if (component.length > 1 || adjacent.get(id)!.includes(id))
        cycles.push(component.sort(compare));
    }
  }
  for (const id of [...ids].sort(compare)) if (!indices.has(id)) visit(id);
  return cycles.sort((a, b) => compare(a.join("\0"), b.join("\0")));
}

export function graphRevision(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  salt = "",
): string {
  return hash(JSON.stringify({ nodes, edges, salt })).slice(0, 20);
}

export function emptyStats(): ArchitectureGraph["stats"] {
  return { files: 0, parsed: 0, cached: 0, durationMs: 0 };
}
