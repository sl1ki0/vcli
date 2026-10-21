import { isAbsolute, resolve } from "node:path";
import type {
  ArchitectureDesign,
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
  Drift,
  Evidence,
} from "@vcli/core";
import { emptyStats, findCycles, graphRevision } from "./graph.ts";
import { compare, matchesPath, slash } from "./utils.ts";
import { writeArchitectureState, readArchitectureState } from "./state-path.ts";

export class ArchitectureDesignError extends Error {
  constructor(message: string) {
    super(`Invalid architecture design: ${message}`);
    this.name = "ArchitectureDesignError";
  }
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()))
    throw new ArchitectureDesignError(`${location} must be an array of nonempty strings`);
  return [...value];
}

export function validateDesign(value: unknown): ArchitectureDesign {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ArchitectureDesignError("expected an object");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new ArchitectureDesignError("version must be 1");
  if (!Array.isArray(input.components))
    throw new ArchitectureDesignError("components must be an array");
  const ids = new Set<string>();
  const components = input.components.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ArchitectureDesignError(`components[${i}] must be an object`);
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id.trim())
      throw new ArchitectureDesignError(`components[${i}].id is required`);
    if (ids.has(c.id)) throw new ArchitectureDesignError(`duplicate component id ${c.id}`);
    ids.add(c.id);
    if (typeof c.label !== "string" || !c.label.trim())
      throw new ArchitectureDesignError(`components[${i}].label is required`);
    const paths = strings(c.paths, `components[${i}].paths`).map(slash);
    if (paths.some((p) => isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")))
      throw new ArchitectureDesignError(`components[${i}].paths must stay relative to the project`);
    return {
      id: c.id,
      label: c.label,
      paths,
      ...(c.dependencies !== undefined
        ? { dependencies: strings(c.dependencies, `components[${i}].dependencies`) }
        : {}),
      ...(c.forbiddenDependencies !== undefined
        ? {
            forbiddenDependencies: strings(
              c.forbiddenDependencies,
              `components[${i}].forbiddenDependencies`,
            ),
          }
        : {}),
    };
  });
  for (const c of components) {
    for (const target of [...(c.dependencies ?? []), ...(c.forbiddenDependencies ?? [])]) {
      if (!ids.has(target))
        throw new ArchitectureDesignError(`${c.id} references unknown component ${target}`);
    }
  }
  return { version: 1, components, decisions: strings(input.decisions, "decisions") };
}

export async function readDesign(root: string): Promise<ArchitectureDesign> {
  try {
    return validateDesign(
      JSON.parse(await readArchitectureState(root, ["architecture.json"], 1024 * 1024)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, components: [], decisions: [] };
    if (error instanceof SyntaxError)
      throw new ArchitectureDesignError("architecture.json is not valid JSON");
    throw error;
  }
}

export async function writeDesign(root: string, value: ArchitectureDesign): Promise<void> {
  const design = validateDesign(value);
  const content = `${JSON.stringify(design, null, 2)}\n`;
  if (Buffer.byteLength(content) > 1024 * 1024)
    throw new ArchitectureDesignError("design exceeds 1 MiB");
  writeArchitectureState(root, ".vcli/architecture.json", content);
}

export function intendedGraph(root: string, value: ArchitectureDesign): ArchitectureGraph {
  const design = validateDesign(value);
  const nodes: ArchitectureNode[] = design.components.map((c) => ({
    id: `component:${c.id}`,
    label: c.label,
    kind: "component",
    status: "planned",
  }));
  const edges: ArchitectureEdge[] = design.components.flatMap((c) =>
    (c.dependencies ?? []).map((target) => ({
      id: `planned:${c.id}->${target}`,
      source: `component:${c.id}`,
      target: `component:${target}`,
      kind: "uses" as const,
      status: "planned" as const,
    })),
  );
  nodes.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(a.id, b.id));
  return {
    root: resolve(root),
    nodes,
    edges,
    revision: graphRevision(nodes, edges, JSON.stringify(design)),
    cycles: findCycles(nodes, edges),
    diagnostics: [],
    stats: emptyStats(),
  };
}

type Component = ArchitectureDesign["components"][number];

function matchingComponent(path: string, design: ArchitectureDesign): Component | undefined {
  const matches = design.components.flatMap((c) =>
    c.paths
      .filter((p) => matchesPath(path, p))
      .map((p) => ({ c, score: p.replace(/[?*]/g, "").length })),
  );
  matches.sort((a, b) => b.score - a.score || compare(a.c.id, b.c.id));
  return matches[0]?.c;
}

export function check(graph: ArchitectureGraph, value: ArchitectureDesign): Drift[] {
  const design = validateDesign(value);
  if (!design.components.length) return [];
  const drift: Drift[] = [];
  const mappings = new Map<string, Component>();
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.path || (node.kind !== "module" && node.kind !== "file")) continue;
    const component = matchingComponent(node.path, design);
    if (component) {
      mappings.set(node.id, component);
      seen.add(component.id);
    } else
      drift.push({
        kind: "unmapped-module",
        message: `${node.path} is outside the designed component boundaries`,
        evidence: node.evidence,
      });
  }
  for (const component of design.components) {
    if (!seen.has(component.id))
      drift.push({
        kind: "missing-component",
        message: `${component.label} (${component.id}) has no observed source files`,
      });
  }
  const violations = new Map<
    string,
    { source: Component; target: Component; evidence: Evidence[]; explicit: boolean }
  >();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") continue;
    const source = mappings.get(edge.source),
      target = mappings.get(edge.target);
    if (!source || !target || source.id === target.id) continue;
    const explicit = source.forbiddenDependencies?.includes(target.id) ?? false;
    if (!explicit && (source.dependencies === undefined || source.dependencies.includes(target.id)))
      continue;
    const key = `${source.id}\0${target.id}`;
    const violation = violations.get(key) ?? { source, target, evidence: [], explicit };
    violation.evidence.push(...(edge.evidence ?? []));
    violations.set(key, violation);
  }
  for (const [, v] of [...violations.entries()].sort(([a], [b]) => compare(a, b))) {
    const evidence = [
      ...new Map(v.evidence.map((e) => [`${e.path}:${e.line}:${e.endLine ?? e.line}`, e])).values(),
    ];
    drift.push({
      kind: "forbidden-dependency",
      message: `${v.source.label} depends on ${v.target.label}, ${v.explicit ? "which is explicitly forbidden" : "which is outside its allowed dependencies"}`,
      evidence,
    });
  }
  return drift.sort((a, b) => compare(`${a.kind}:${a.message}`, `${b.kind}:${b.message}`));
}
