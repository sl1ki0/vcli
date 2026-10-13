import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { Resvg } from "@resvg/resvg-js";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@vcli/core";
import fontAsset from "../resources/JetBrainsMono-Regular.ttf" with { type: "file" };
import { compare } from "./utils.ts";

export interface Point {
  x: number;
  y: number;
}
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}
export interface LayoutNode extends ArchitectureNode {
  x: number;
  y: number;
  width: number;
  height: number;
  memberIds?: string[];
}
export interface LayoutEdge extends ArchitectureEdge {
  points: Point[];
}
export interface LayoutScene {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  omittedNodes: number;
}
export interface LayoutOptions {
  direction?: "RIGHT" | "DOWN";
  maxNodes?: number;
  includeExternal?: boolean;
}
export interface SvgOptions {
  theme?: "dark" | "light";
  selectedNodeId?: string;
  viewport?: Viewport;
}

function summarize(
  graph: ArchitectureGraph,
  options: LayoutOptions,
): {
  nodes: (ArchitectureNode & { memberIds?: string[] })[];
  edges: ArchitectureEdge[];
  omitted: number;
} {
  const maximum = Math.max(2, Math.floor(options.maxNodes ?? 80));
  const candidates = graph.nodes.filter(
    (n) => n.kind !== "package" && (options.includeExternal || n.kind !== "external"),
  );
  const available = new Set(candidates.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => e.kind !== "contains" && available.has(e.source) && available.has(e.target),
  );
  if (candidates.length <= maximum) return { nodes: candidates, edges, omitted: 0 };
  const graphNodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map<string, ArchitectureNode & { memberIds: string[] }>();
  const mapping = new Map<string, string>();
  for (const node of candidates) {
    let id = node.id,
      summary = node;
    const parent = node.parent ? graphNodes.get(node.parent) : undefined;
    if (parent && parent.path !== ".") {
      id = parent.id;
      summary = parent;
    } else if (node.path && (node.kind === "module" || node.kind === "file")) {
      const parts = node.path.split("/");
      const directory =
        parts.length > 2 && ["src", "lib", "app", "test", "tests"].includes(parts[0]!)
          ? parts.slice(0, 2).join("/")
          : parts.length > 1
            ? parts[0]!
            : ".";
      id = `group:${directory}`;
      summary = {
        id,
        label: directory === "." ? "Root modules" : directory,
        path: directory,
        kind: "component",
        status: "inferred",
      };
    }
    const priorGroup = groups.get(id);
    const group = priorGroup ?? { ...summary, memberIds: [], change: node.change };
    if (priorGroup && priorGroup.change !== node.change && (priorGroup.change || node.change))
      group.change = "modified";
    group.memberIds.push(node.id);
    groups.set(id, group);
    mapping.set(node.id, id);
  }
  if (groups.size > maximum) {
    const degree = new Map<string, number>();
    for (const edge of edges)
      for (const id of [mapping.get(edge.source)!, mapping.get(edge.target)!])
        degree.set(id, (degree.get(id) ?? 0) + 1);
    const retained = [...groups.values()]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || compare(a.id, b.id))
      .slice(0, maximum - 1);
    const retainIds = new Set(retained.map((n) => n.id));
    const overflow = [...groups.values()].filter((n) => !retainIds.has(n.id));
    const members = overflow.flatMap((n) => n.memberIds);
    const summary = {
      id: "group:overflow",
      label: `Other ${members.length} modules`,
      kind: "component" as const,
      status: "inferred" as const,
      memberIds: members,
    };
    for (const node of members) mapping.set(node, summary.id);
    groups.clear();
    for (const node of [...retained, summary]) groups.set(node.id, node);
  }
  const combined = new Map<string, ArchitectureEdge>();
  for (const edge of edges) {
    const source = mapping.get(edge.source)!,
      target = mapping.get(edge.target)!;
    if (source === target) continue;
    const id = `grouped:${edge.kind}:${source}->${target}`;
    const prior = combined.get(id);
    if (prior) prior.evidence = [...(prior.evidence ?? []), ...(edge.evidence ?? [])];
    else combined.set(id, { ...edge, id, source, target });
  }
  return {
    nodes: [...groups.values()],
    edges: [...combined.values()],
    omitted: candidates.length - groups.size,
  };
}

export async function layoutGraph(
  graph: ArchitectureGraph,
  options: LayoutOptions = {},
): Promise<LayoutScene> {
  const summary = summarize(graph, options);
  summary.nodes.sort((a, b) => compare(a.id, b.id));
  summary.edges.sort((a, b) => compare(a.id, b.id));
  if (!summary.nodes.length)
    return { width: 320, height: 120, nodes: [], edges: [], omittedNodes: 0 };
  const children: ElkNode[] = summary.nodes.map((node) => ({
    id: node.id,
    width: Math.max(160, Math.min(300, [...node.label].length * 7.5 + 30)),
    height: 66,
  }));
  // Bun rewrites bundled import.meta.url to the executable entrypoint. The
  // separately compiled worker retains its project-relative output path.
  const virtualRoot = import.meta.url.match(/^(.*?\/(?:\$bunfs|~BUN)\/root\/)/)?.[1];
  const workerUrl = virtualRoot
    ? new URL("packages/architecture/src/layout-worker.js", virtualRoot).href
    : new URL("./layout-worker.ts", import.meta.url).href;
  const worker = new Worker(workerUrl, { preload: [] });
  const workerFailure = new Promise<never>((_, reject) =>
    worker.addEventListener("error", (event) =>
      reject(new Error(`Architecture layout worker failed: ${event.message}`)),
    ),
  );
  const elk = new ELK({ workerFactory: () => worker });
  const input: ElkNode = {
    id: "architecture",
    children,
    edges: summary.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction ?? "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.considerModelOrder.components": "MODEL_ORDER",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
    },
  };
  let layout: ElkNode;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("Architecture layout exceeded its 15 second deadline")),
      15_000,
    );
  });
  try {
    layout = await Promise.race([elk.layout(input), workerFailure, timeout]);
  } finally {
    if (deadline) clearTimeout(deadline);
    elk.terminateWorker();
  }
  const positions = new Map((layout.children ?? []).map((node) => [node.id, node]));
  const edgePositions = new Map(
    ((layout.edges ?? []) as ElkExtendedEdge[]).map((edge) => [edge.id, edge]),
  );
  return {
    width: Math.ceil(layout.width ?? 320),
    height: Math.ceil(layout.height ?? 120),
    omittedNodes: summary.omitted,
    nodes: summary.nodes.map((node) => {
      const p = positions.get(node.id)!;
      return { ...node, x: p.x ?? 0, y: p.y ?? 0, width: p.width!, height: p.height! };
    }),
    edges: summary.edges.map((edge) => ({
      ...edge,
      points: (edgePositions.get(edge.id)?.sections ?? []).flatMap((section) => [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]),
    })),
  };
}

export function viewportToScene(point: Point, viewport: Viewport): Point {
  validateViewport(viewport);
  return { x: point.x / viewport.zoom + viewport.x, y: point.y / viewport.zoom + viewport.y };
}

export function sceneToViewport(point: Point, viewport: Viewport): Point {
  validateViewport(viewport);
  return { x: (point.x - viewport.x) * viewport.zoom, y: (point.y - viewport.y) * viewport.zoom };
}

export function hitTest(scene: LayoutScene, point: Point): LayoutNode | undefined {
  return [...scene.nodes]
    .reverse()
    .find(
      (node) =>
        point.x >= node.x &&
        point.x <= node.x + node.width &&
        point.y >= node.y &&
        point.y <= node.y + node.height,
    );
}

function validateViewport(viewport: Viewport) {
  if (
    ![viewport.x, viewport.y, viewport.zoom, viewport.width, viewport.height].every(
      Number.isFinite,
    ) ||
    viewport.zoom <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new Error("Viewport must have finite dimensions and a positive zoom");
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function number(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
function labelLines(label: string, width: number): string[] {
  const capacity = Math.max(8, Math.floor((width - 28) / 7.3));
  const characters = [...label];
  if (characters.length <= capacity) return [label];
  return [
    characters.slice(0, capacity).join(""),
    characters.length > capacity * 2
      ? `${characters.slice(capacity, capacity * 2 - 1).join("")}…`
      : characters.slice(capacity).join(""),
  ];
}

export function renderSvg(scene: LayoutScene, options: SvgOptions = {}): string {
  const light = options.theme === "light";
  const color = light
    ? {
        background: "#f8fafc",
        panel: "#ffffff",
        text: "#0f172a",
        muted: "#64748b",
        border: "#cbd5e1",
        edge: "#64748b",
        accent: "#0284c7",
        planned: "#7c3aed",
        warning: "#d97706",
      }
    : {
        background: "#0b1220",
        panel: "#131e30",
        text: "#e2e8f0",
        muted: "#94a3b8",
        border: "#334155",
        edge: "#64748b",
        accent: "#38bdf8",
        planned: "#c4b5fd",
        warning: "#fbbf24",
      };
  const viewport = options.viewport;
  if (viewport) validateViewport(viewport);
  const width = Math.ceil(viewport?.width ?? scene.width),
    height = Math.ceil(viewport?.height ?? scene.height);
  const transform = viewport
    ? `translate(${number(-viewport.x * viewport.zoom)},${number(-viewport.y * viewport.zoom)}) scale(${number(viewport.zoom)})`
    : "";
  const content: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Project architecture</title><rect width="100%" height="100%" fill="${color.background}"/><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color.edge}"/></marker></defs><g${transform ? ` transform="${transform}"` : ""} font-family="JetBrains Mono" font-size="12">`,
  ];
  const changeColor = {
    added: light ? "#15803d" : "#4ade80",
    removed: light ? "#b91c1c" : "#f87171",
    modified: light ? "#b45309" : "#fbbf24",
  };
  for (const edge of scene.edges) {
    if (edge.points.length < 2) continue;
    const selected =
      edge.source === options.selectedNodeId || edge.target === options.selectedNodeId;
    const path = edge.points
      .map((p, i) => `${i ? "L" : "M"}${number(p.x)},${number(p.y)}`)
      .join(" ");
    const stroke = edge.change ? changeColor[edge.change] : selected ? color.accent : color.edge;
    content.push(
      `<path data-edge="${xml(edge.id)}" d="${path}" fill="none" stroke="${stroke}" stroke-width="${selected ? 2.3 : 1.4}"${edge.kind === "type-import" || edge.status === "planned" || edge.change === "removed" ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#arrow)"/>`,
    );
  }
  for (const node of scene.nodes) {
    const selected = node.id === options.selectedNodeId;
    const border = node.change
      ? changeColor[node.change]
      : selected
        ? color.accent
        : node.status === "planned"
          ? color.planned
          : node.status === "unresolved"
            ? color.warning
            : color.border;
    const x = number(node.x),
      y = number(node.y);
    content.push(
      `<g data-node="${xml(node.id)}"><title>${xml(node.label)}</title><rect x="${x}" y="${y}" width="${number(node.width)}" height="${number(node.height)}" rx="8" fill="${color.panel}" stroke="${border}" stroke-width="${selected ? 2.5 : 1.2}"${node.status === "planned" || node.status === "inferred" || node.change === "removed" ? ' stroke-dasharray="5 3"' : ""}/>`,
    );
    const label = labelLines(node.label, node.width);
    for (const [i, line] of label.entries())
      content.push(
        `<text x="${number(node.x + 14)}" y="${number(node.y + 22 + i * 15)}" fill="${color.text}">${xml(line)}</text>`,
      );
    const caption = `${node.memberIds ? `${node.memberIds.length} modules` : node.kind}${node.change ? ` · ${node.change}` : node.status && node.status !== "observed" ? ` · ${node.status}` : ""}`;
    content.push(
      `<text x="${number(node.x + 14)}" y="${number(node.y + node.height - 11)}" fill="${node.change ? changeColor[node.change] : color.muted}" font-size="10">${xml(caption)}</text></g>`,
    );
  }
  if (!scene.nodes.length)
    content.push(`<text x="24" y="64" fill="${color.muted}">No architecture nodes yet</text>`);
  content.push("</g></svg>");
  return content.join("");
}

let nativeFont: string | undefined;
function fontFile(): string {
  if (nativeFont) return nativeFont;
  // Bun embeds the asset in executable builds; native resvg needs a real file.
  const directory = mkdtempSync(join(tmpdir(), "vcli-font-"));
  nativeFont = join(directory, "JetBrainsMono-Regular.ttf");
  writeFileSync(nativeFont, readFileSync(fontAsset), { mode: 0o600 });
  process.once("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* The operating system also cleans its temporary directory. */
    }
  });
  return nativeFont;
}

export function rasterize(svg: string): Uint8Array {
  const renderer = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [fontFile()],
      defaultFontFamily: "JetBrains Mono",
      monospaceFamily: "JetBrains Mono",
    },
    logLevel: "off",
  });
  return renderer.render().asPng();
}
