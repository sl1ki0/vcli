import type { BoxRenderable, CliRenderer, ImageRenderable, MouseEvent } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";
import {
  layoutGraph,
  rasterize,
  renderSvg,
  viewportToScene,
  type LayoutScene,
  type Viewport,
} from "@vcli/architecture";
import type { ArchitectureGraph, ArchitectureNode } from "@vcli/core";
import type { WorkspaceOptions } from "./contracts.ts";

interface CanvasOptions {
  renderer: CliRenderer;
  mode: WorkspaceOptions["renderer"];
  dimensions: Accessor<{ width: number; height: number }>;
  enabled: Accessor<boolean>;
  graph: Accessor<ArchitectureGraph>;
  visibleNodes: Accessor<ArchitectureNode[]>;
  selected: Accessor<string | undefined>;
  scene: Accessor<LayoutScene | undefined>;
  setScene: Setter<LayoutScene | undefined>;
  pan: Accessor<{ x: number; y: number; scale: number }>;
  width: Accessor<number>;
  height: Accessor<number>;
  selectPoint(point: { x: number; y: number }): void;
  activity(message: string): void;
}

/** Image layout, painting and hit testing always use one viewport transform. */
export function createArchitectureCanvas(options: CanvasOptions) {
  const renderer = options.renderer;
  const [image, setImage] = createSignal<Uint8Array>();
  const [imageFailed, setImageFailed] = createSignal(false);
  const [capVersion, setCapVersion] = createSignal(0);
  let canvasBox: BoxRenderable | undefined;
  let imageRef: ImageRenderable | undefined;
  let pendingLayout: Promise<void> | undefined;
  const graphics = createMemo(() => {
    capVersion();
    const caps = renderer.capabilities;
    if (!options.enabled() || options.mode === "off" || imageFailed()) return false;
    if (options.mode !== "auto") return true;
    return Boolean(
      caps &&
        caps.multiplexer === "none" &&
        (caps.kitty_graphics || (caps.sixel && renderer.resolution)),
    );
  });
  const protocol = () => (options.mode === "off" ? "auto" : options.mode);
  const viewport = createMemo<Viewport>(() => {
    capVersion();
    const current = options.scene();
    const resolution = renderer.resolution;
    const cellWidth = resolution ? resolution.width / options.dimensions().width : 10;
    const cellHeight = resolution ? resolution.height / options.dimensions().height : 20;
    const width = Math.max(150, options.width() * cellWidth);
    const height = Math.max(80, options.height() * cellHeight);
    const zoom =
      Math.min(
        width / Math.max(1, current?.width ?? width),
        height / Math.max(1, current?.height ?? height),
      ) * options.pan().scale;
    return { x: options.pan().x, y: options.pan().y, zoom, width, height };
  });
  createEffect(() => {
    if (!graphics()) {
      options.setScene(undefined);
      pendingLayout = undefined;
      return;
    }
    const snapshot = options.graph();
    const ids = new Set(options.visibleNodes().map((node) => node.id));
    const filtered = {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => ids.has(node.id)),
      edges: snapshot.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
    let current = true;
    pendingLayout = layoutGraph(filtered)
      .then((result) => {
        if (current) options.setScene(result);
      })
      .catch((error) => options.activity(String(error)));
    onCleanup(() => {
      current = false;
    });
  });
  createEffect(() => {
    const current = options.scene();
    const selectedNodeId = options.selected();
    const area = viewport();
    capVersion();
    if (!current || !graphics()) {
      setImage(undefined);
      return;
    }
    try {
      setImage(
        rasterize(
          renderSvg(current, {
            theme: renderer.themeMode === "light" ? "light" : "dark",
            selectedNodeId,
            viewport: area,
          }),
        ),
      );
    } catch (error) {
      setImage(undefined);
      options.activity(`Diagram renderer: ${String(error)}`);
    }
  });
  function selectAt(event: MouseEvent) {
    if (!graphics() || !canvasBox || !options.scene() || imageRef?.loading) return;
    const local = { x: event.x - canvasBox.x, y: event.y - canvasBox.y };
    const area = viewport();
    options.selectPoint(
      viewportToScene(
        {
          x: (local.x / options.width()) * area.width,
          y: (local.y / options.height()) * area.height,
        },
        area,
      ),
    );
  }
  async function present() {
    await pendingLayout;
    await imageRef?.loadPromise;
    renderer.requestRender();
    await renderer.idle();
  }
  onMount(() => {
    let resolution = JSON.stringify(renderer.resolution);
    const capability = () => {
      setImageFailed(false);
      setCapVersion((version) => version + 1);
    };
    const frame = () => {
      const current = JSON.stringify(renderer.resolution);
      if (current !== resolution) {
        resolution = current;
        capability();
      }
    };
    renderer.on("capabilities", capability);
    renderer.on("resize", capability);
    renderer.on("frame", frame);
    renderer.on("theme_mode", capability);
    onCleanup(() => {
      renderer.off("capabilities", capability);
      renderer.off("resize", capability);
      renderer.off("frame", frame);
      renderer.off("theme_mode", capability);
    });
  });
  return {
    image,
    graphics,
    protocol,
    selectAt,
    present,
    setCanvasBox: (box: BoxRenderable) => {
      canvasBox = box;
    },
    setImageRef: (image: ImageRenderable) => {
      imageRef = image;
    },
    imageProtocol: () => imageRef?.effectiveProtocol,
    imageError: (error: unknown) => {
      setImageFailed(true);
      options.activity("Image display failed: " + String(error));
    },
  };
}
