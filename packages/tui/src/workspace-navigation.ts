import type { KeyEvent } from "@opentui/core";
import { createMemo, createSignal, type Accessor } from "solid-js";
import { hitTest, type LayoutScene, type Point } from "@vcli/architecture";
import type { ArchitectureGraph } from "@vcli/core";

interface NavigationOptions {
  graph: Accessor<ArchitectureGraph>;
  scene: Accessor<LayoutScene | undefined>;
  graphics: Accessor<boolean>;
  narrow: Accessor<boolean>;
  refresh(): Promise<void>;
  cycleView(): void;
  close(): void;
}

/** Graph exploration state shared by keyboard, canvas clicks and tree rows. */
export function createWorkspaceNavigation(options: NavigationOptions) {
  const [selected, setSelected] = createSignal(
    options.graph().nodes.find((node) => node.kind === "module")?.id ??
      options.graph().nodes[0]?.id,
  );
  const [canvasFocus, setCanvasFocus] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [drill, setDrill] = createSignal<string>();
  const [drillMembers, setDrillMembers] = createSignal<Set<string>>();
  const [pan, setPan] = createSignal({ x: 0, y: 0, scale: 1 });
  const [showTree, setShowTree] = createSignal(true);
  const [narrowPanel, setNarrowPanel] = createSignal<"canvas" | "tree" | "inspector">("canvas");

  const visibleNodes = createMemo(() =>
    options
      .graph()
      .nodes.filter(
        (node) =>
          node.kind !== "external" &&
          (!query() ||
            `${node.label} ${node.path ?? ""}`.toLowerCase().includes(query().toLowerCase())) &&
          (!drill() ||
            drillMembers()?.has(node.id) ||
            node.id === drill() ||
            node.parent === drill() ||
            node.path?.startsWith(
              options.graph().nodes.find((parent) => parent.id === drill())?.path ?? "!",
            )),
      )
      .filter((node) => !node.parent || !collapsed().has(node.parent)),
  );
  const selectedNode = createMemo(
    () =>
      options.graph().nodes.find((node) => node.id === selected()) ??
      options.scene()?.nodes.find((node) => node.id === selected()),
  );

  function selectNode(id: string) {
    setSelected(id);
    setCanvasFocus(true);
  }

  function selectPoint(point: Point) {
    const scene = options.scene();
    if (!scene) return;
    const node = hitTest(scene, point);
    if (node) selectNode(node.id);
  }

  function resetViewport() {
    setPan({ x: 0, y: 0, scale: 1 });
  }

  function applySearch(value: string) {
    setQuery(value);
    setSearching(false);
    setCanvasFocus(true);
  }

  function moveSelection(backwards: boolean) {
    const nodes = options.graphics() ? (options.scene()?.nodes ?? visibleNodes()) : visibleNodes();
    const index = nodes.findIndex((node) => node.id === selected());
    const next = (index + (backwards ? -1 : 1) + nodes.length) % nodes.length;
    setSelected(nodes[next]?.id);
  }

  function toggleCollapsed() {
    const id = selected();
    if (!id) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleKey(key: KeyEvent) {
    if (key.name === "tab") {
      key.preventDefault();
      setCanvasFocus(!canvasFocus());
      return;
    }
    if (!canvasFocus()) return;
    key.preventDefault();
    switch (key.name) {
      case "escape":
        setDrill(undefined);
        setDrillMembers(undefined);
        setQuery("");
        resetViewport();
        break;
      case "up":
      case "down":
      case "left":
      case "right":
        if (key.shift)
          setPan((previous) => ({
            ...previous,
            x: previous.x + (key.name === "right" ? 60 : key.name === "left" ? -60 : 0),
            y: previous.y + (key.name === "down" ? 60 : key.name === "up" ? -60 : 0),
          }));
        else moveSelection(key.name === "up" || key.name === "left");
        break;
      case "+":
      case "=":
      case "-":
        setPan((previous) => ({
          ...previous,
          scale: Math.max(0.2, Math.min(8, previous.scale * (key.name === "-" ? 0.8 : 1.25))),
        }));
        break;
      case "return":
        setDrillMembers(
          new Set(options.scene()?.nodes.find((node) => node.id === selected())?.memberIds ?? []),
        );
        setDrill(selected());
        resetViewport();
        break;
      case "space":
        toggleCollapsed();
        break;
      case "/":
        setSearching(true);
        setCanvasFocus(false);
        break;
      case "t":
        if (options.narrow())
          setNarrowPanel(
            narrowPanel() === "canvas" ? "tree" : narrowPanel() === "tree" ? "inspector" : "canvas",
          );
        else setShowTree(!showTree());
        break;
      case "v":
        options.cycleView();
        break;
      case "r":
        void options.refresh();
        break;
      case "q":
        options.close();
        break;
    }
  }

  return {
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
    selectNode,
    selectPoint,
    resetViewport,
    applySearch,
    handleKey,
  };
}
