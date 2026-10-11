import { type BoxRenderable, type ImageRenderable, type MouseEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  layoutGraph,
  rasterize,
  renderSvg,
  viewportToScene,
  type LayoutScene,
  type Viewport,
} from "@vcli/architecture";
import { diffGraph, type ArchitectureGraph, type RuntimeEvent, type Session } from "@vcli/core";
import type { WorkspaceOptions } from "./contracts.ts";
import { createWorkspaceNavigation } from "./workspace-navigation.ts";
import { createWorkspaceCommands } from "./workspace-commands.ts";
export function useWorkspaceState(props: WorkspaceOptions) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [graph, setGraph] = createSignal(props.graph);
  const baseline = props.graph;
  const [view, setView] = createSignal<"observed" | "intended" | "changes">("observed");
  const [scene, setScene] = createSignal<LayoutScene>();
  const [image, setImage] = createSignal<Uint8Array>();
  const [imageFailed, setImageFailed] = createSignal(false);
  const [activity, setActivity] = createSignal("Ready. Explore the graph or describe a task.");
  const [transcript, setTranscript] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const [usage, setUsage] = createSignal("0 tokens");
  const [capVersion, setCapVersion] = createSignal(0);
  const [approval, setApproval] = createSignal<{
    label: string;
    finish: (allow: boolean) => void;
  }>();
  const [touched, setTouched] = createSignal<Set<string>>(new Set());
  let controller: AbortController | undefined;
  let canvasBox: BoxRenderable | undefined;
  let imageRef: ImageRenderable | undefined;
  let refreshBusy = false;
  let pendingLayout: Promise<void> | undefined;
  const narrow = createMemo(() => dimensions().width < 110);
  const navigation = createWorkspaceNavigation({
    graph,
    scene,
    narrow,
    graphics: () => graphics(),
    refresh: () => refresh(),
    cycleView: () => {
      setView(view() === "observed" ? "intended" : view() === "intended" ? "changes" : "observed");
      void refresh();
    },
    close: () => renderer.destroy(),
  });
  const {
    selected,
    setSelected,
    selectedNode,
    canvasFocus,
    setCanvasFocus,
    searching,
    collapsed,
    pan,
    showTree,
    narrowPanel,
    visibleNodes,
  } = navigation;
  const commands = createWorkspaceCommands({
    workspace: props,
    graph,
    running,
    activity: setActivity,
    refresh: () => refresh(),
    changeView: async (next) => {
      setView(next);
      await refresh();
    },
    close: () => renderer.destroy(),
  });
  const treeWidth = createMemo(() => (!narrow() && showTree() ? 25 : 0));
  const inspectorWidth = createMemo(() => (narrow() ? 0 : 28));
  const canvasWidth = createMemo(() =>
    Math.max(15, dimensions().width - treeWidth() - inspectorWidth()),
  );
  const canvasHeight = createMemo(() => Math.max(4, dimensions().height - 11));
  const graphics = createMemo(() => {
    capVersion();
    const caps = renderer.capabilities;
    if (props.renderer === "off" || imageFailed() || commands.panel() || commands.emptyProject())
      return false;
    if (narrow() && narrowPanel() !== "canvas") return false;
    if (props.renderer !== "auto") return true;
    return Boolean(
      caps &&
        caps.multiplexer === "none" &&
        (caps.kitty_graphics || (caps.sixel && renderer.resolution)),
    );
  });
  const protocol = createMemo(() => (props.renderer === "off" ? "auto" : props.renderer));
  const viewport = createMemo<Viewport>(() => {
    capVersion();
    const current = scene();
    const resolution = renderer.resolution;
    const cellWidth = resolution ? resolution.width / dimensions().width : 10;
    const cellHeight = resolution ? resolution.height / dimensions().height : 20;
    const width = Math.max(150, canvasWidth() * cellWidth);
    const height = Math.max(80, canvasHeight() * cellHeight);
    const zoom =
      Math.min(
        width / Math.max(1, current?.width ?? width),
        height / Math.max(1, current?.height ?? height),
      ) * pan().scale;
    return { x: pan().x, y: pan().y, zoom, width, height };
  });
  const refresh = async () => {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const observed = await props.architecture.scan(props.root);
      const design = await props.architecture.readDesign(props.root);
      if (view() === "intended") setGraph(props.architecture.intendedGraph(props.root, design));
      else {
        const next = view() === "changes" ? diffGraph(baseline, observed) : observed;
        if (
          next.revision !== graph().revision ||
          graph().nodes.some((n) => n.change) !== (view() === "changes")
        )
          setGraph(next);
        if (view() === "changes")
          setActivity(
            props.architecture
              .check(observed, design)
              .map((d) => d.message)
              .join("\n") || "Changes since opening the workspace; no declared drift.",
          );
      }
    } catch (error) {
      setActivity(String(error));
    } finally {
      refreshBusy = false;
    }
  };
  createEffect(() => {
    if (!graphics()) {
      setScene(undefined);
      pendingLayout = undefined;
      return;
    }
    const snapshot = graph();
    const ids = new Set(visibleNodes().map((n) => n.id));
    const filtered = {
      ...snapshot,
      nodes: snapshot.nodes.filter((n) => ids.has(n.id)),
      edges: snapshot.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
    let current = true;
    pendingLayout = layoutGraph(filtered)
      .then((result) => {
        if (current) setScene(result);
      })
      .catch((error) => {
        setActivity(String(error));
      });
    onCleanup(() => {
      current = false;
    });
  });
  createEffect(() => {
    const current = scene();
    const selectedNodeId = selected();
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
      setActivity(`Diagram renderer: ${String(error)}`);
    }
  });
  const acceptEvent = async (event: RuntimeEvent) => {
    if (event.type === "text")
      setTranscript((previous) => (previous + String(event.data.text)).slice(-10_000));
    if (event.type === "tool-start") {
      setActivity(`Working: ${event.data.name}`);
      const args = event.data.arguments as Record<string, unknown> | undefined;
      const active = graph().nodes.find((n) => n.path === args?.path);
      if (active) setSelected(active.id);
    }
    if (event.type === "tool-end") {
      setActivity(`${event.data.name}: ${String(event.data.result).slice(0, 500)}`);
      const paths = event.data.changedPaths as string[] | undefined;
      if (paths) setTouched((previous) => new Set([...previous, ...paths]));
      if (event.data.name === "architecture_propose" && !event.data.isError) {
        const intended = (event.data.details as { intended?: ArchitectureGraph } | undefined)
          ?.intended;
        if (intended) {
          setView("intended");
          setGraph(intended);
          navigation.resetViewport();
          // Present the managed graphics surface before the next mutation.
          await pendingLayout;
          await imageRef?.loadPromise;
          renderer.requestRender();
          await renderer.idle();
        }
      }
    }
    if (event.type === "architecture" && view() !== "intended")
      setGraph(
        view() === "changes"
          ? diffGraph(baseline, event.data.graph as ArchitectureGraph)
          : (event.data.graph as ArchitectureGraph),
      );
    if (event.type === "usage") {
      const total = event.data.total as Session["usage"];
      setUsage(`${total.input + total.output} tokens · ${total.cached} cached`);
    }
    if (event.type === "status")
      setActivity(`${event.data.status}${event.data.error ? ": " + event.data.error : ""}`);
    if (event.type === "compaction") setActivity("Context reduced; task ledger preserved.");
  };
  const submit = async (prompt: string) => {
    if (searching()) {
      navigation.applySearch(prompt);
      return;
    }
    if (!prompt.trim()) return;
    if (await commands.execute(prompt)) return;
    if (running()) return;
    if (!commands.ready() || !props.run) {
      commands.open("connect");
      setActivity("Connect a provider and model with /connect before starting a task.");
      return;
    }
    controller = new AbortController();
    setRunning(true);
    setTranscript("");
    try {
      await props.run(
        prompt,
        controller.signal,
        acceptEvent,
        (tool, args) =>
          new Promise<boolean>((finish) => {
            setApproval({ label: `${tool.name}: ${JSON.stringify(args).slice(0, 700)}`, finish });
          }),
      );
    } catch (error) {
      setActivity(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      setApproval(undefined);
      await refresh();
    }
  };
  const selectAt = (event: MouseEvent) => {
    if (!graphics() || !canvasBox || !scene() || imageRef?.loading) return;
    const local = { x: event.x - canvasBox.x, y: event.y - canvasBox.y };
    const area = viewport();
    const point = viewportToScene(
      { x: (local.x / canvasWidth()) * area.width, y: (local.y / canvasHeight()) * area.height },
      area,
    );
    navigation.selectPoint(point);
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (running()) {
        approval()?.finish(false);
        setApproval(undefined);
        controller?.abort();
      } else renderer.destroy();
      return;
    }
    if (approval()) {
      key.preventDefault();
      if (key.name === "y" || key.name === "n") {
        approval()!.finish(key.name === "y");
        setApproval(undefined);
      }
      return;
    }
    if (commands.handleKey(key)) return;
    navigation.handleKey(key);
  });
  usePaste((event) => {
    commands.handlePaste(event);
  });
  onMount(() => {
    let resolution = JSON.stringify(renderer.resolution);
    const capability = () => {
      setImageFailed(false);
      setCapVersion((v) => v + 1);
    };
    renderer.on("capabilities", capability);
    renderer.on("resize", capability);
    const frame = () => {
      const current = JSON.stringify(renderer.resolution);
      if (current !== resolution) {
        resolution = current;
        capability();
      }
    };
    renderer.on("frame", frame);
    renderer.on("theme_mode", capability);
    const interval = setInterval(() => {
      if (!running()) void refresh();
    }, 2_500);
    onCleanup(() => {
      clearInterval(interval);
      renderer.off("capabilities", capability);
      renderer.off("resize", capability);
      renderer.off("frame", frame);
      renderer.off("theme_mode", capability);
    });
  });
  onCleanup(() => {
    approval()?.finish(false);
    controller?.abort();
  });
  return {
    commands,
    view,
    usage,
    graph,
    graphics,
    treeWidth,
    visibleNodes,
    selected,
    setSelected,
    setCanvasFocus,
    collapsed,
    canvasWidth,
    canvasHeight,
    selectAt,
    selectNode: navigation.selectNode,
    image,
    touched,
    canvasFocus,
    protocol,
    narrow,
    narrowPanel,
    inspectorWidth,
    selectedNode,
    approval,
    activity,
    transcript,
    searching,
    running,
    submit,
    setCanvasBox: (box: BoxRenderable) => {
      canvasBox = box;
    },
    setImageRef: (image: ImageRenderable) => {
      imageRef = image;
    },
    imageProtocol: () => imageRef?.effectiveProtocol,
    imageError: (error: unknown) => {
      setImageFailed(true);
      setActivity("Image display failed: " + String(error));
    },
  };
}
export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
