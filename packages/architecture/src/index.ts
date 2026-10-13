import type { ArchitectureService } from "@vcli/core";
import { check, intendedGraph, readDesign, writeDesign } from "./design.ts";
import { scan } from "./scan.ts";

export function createArchitectureService(): ArchitectureService {
  return { scan, check, intendedGraph, readDesign, writeDesign };
}

export {
  check,
  intendedGraph,
  readDesign,
  writeDesign,
  validateDesign,
  ArchitectureDesignError,
} from "./design.ts";
export { scan } from "./scan.ts";
export { findCycles } from "./graph.ts";
export {
  layoutGraph,
  renderSvg,
  rasterize,
  hitTest,
  viewportToScene,
  sceneToViewport,
} from "./render.ts";
export type {
  Point,
  Viewport,
  LayoutNode,
  LayoutEdge,
  LayoutScene,
  LayoutOptions,
  SvgOptions,
} from "./render.ts";
