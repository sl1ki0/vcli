import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { LayoutScene } from "@vcli/architecture";
import { diffGraph, type ArchitectureGraph, type RuntimeEvent, type Session } from "@vcli/core";
import type { WorkspaceOptions } from "./contracts.ts";
import { createWorkspaceNavigation } from "./workspace-navigation.ts";
import { createWorkspaceCommands } from "./workspace-commands.ts";
import { createWorkspaceFocus } from "./workspace-focus.ts";
import { createArchitectureCanvas } from "./architecture-canvas.ts";
import { createConversation } from "./chat/conversation.ts";
import { createChatTask } from "./chat/task.ts";

/** Assemble presentation controllers; each owns one independent interaction surface. */
export function useWorkspaceState(props: WorkspaceOptions) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [graph, setGraph] = createSignal(props.graph);
  const baseline = props.graph;
  const [view, setView] = createSignal<"observed" | "intended" | "changes">("observed");
  const [preview, setPreview] = createSignal<ArchitectureGraph>();
  const [scene, setScene] = createSignal<LayoutScene>();
  const [activity, setActivity] = createSignal("Ready. Explore the graph or describe a task.");
  const [usage, setUsage] = createSignal(
    props.initialSession ? usageLabel(props.initialSession.usage) : "0 tokens",
  );
  const [touched, setTouched] = createSignal<Set<string>>(new Set());
  const conversation = createConversation(props.initialSession);
  let refreshBusy = false;
  const narrow = createMemo(() => dimensions().width < 110);
  const task = createChatTask({
    workspace: props,
    conversation,
    emit: (event) => acceptEvent(event),
    activity: setActivity,
    refresh: () => refresh(),
    present: async () => {
      renderer.requestRender();
      await renderer.idle();
    },
  });
  const navigation = createWorkspaceNavigation({
    graph,
    scene,
    narrow,
    graphics: () => canvas.graphics(),
    refresh: () => refresh(),
    cycleView: () => {
      setView(view() === "observed" ? "intended" : view() === "intended" ? "changes" : "observed");
      void refresh();
    },
    close: () => renderer.destroy(),
  });
  const focus = createWorkspaceFocus({ navigation, conversation, dimensions });
  const commands = createWorkspaceCommands({
    workspace: props,
    graph,
    running: task.running,
    approve: task.requestApproval,
    activity: setActivity,
    refresh: () => refresh(),
    changeView: async (next) => {
      setView(next);
      await refresh();
    },
    close: () => renderer.destroy(),
    changeLayout: focus.changeLayout,
    restoreSession: (session) => {
      setPreview(undefined);
      conversation.restore(session);
      setUsage(usageLabel(session.usage));
      focus.clearInput();
      focus.returnToInput();
      if (focus.layout() === "architecture") focus.changeLayout("split");
      void refresh();
    },
    clearConversation: () => {
      setPreview(undefined);
      conversation.clear();
      setUsage("0 tokens");
      focus.clearInput();
      focus.returnToInput();
    },
  });
  const treeWidth = createMemo(() => (!narrow() && navigation.showTree() ? 25 : 0));
  const inspectorWidth = createMemo(() => (narrow() ? 0 : 28));
  const canvasWidth = createMemo(() =>
    Math.max(15, dimensions().width - treeWidth() - inspectorWidth()),
  );
  const canvas = createArchitectureCanvas({
    renderer,
    mode: props.renderer,
    dimensions,
    graph,
    scene,
    setScene,
    visibleNodes: navigation.visibleNodes,
    selected: navigation.selected,
    pan: navigation.pan,
    width: canvasWidth,
    height: focus.canvasHeight,
    selectPoint: navigation.selectPoint,
    activity: setActivity,
    enabled: () =>
      focus.layout() !== "chat" &&
      !commands.panel() &&
      !commands.emptyProject() &&
      (!narrow() || navigation.narrowPanel() === "canvas"),
  });
  async function refresh() {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const observed = await props.architecture.scan(props.root);
      const design = await props.architecture.readDesign(props.root);
      if (view() === "intended")
        setGraph(preview() ?? props.architecture.intendedGraph(props.root, design));
      else {
        const next = view() === "changes" ? diffGraph(baseline, observed) : observed;
        if (
          next.revision !== graph().revision ||
          graph().nodes.some((node) => node.change) !== (view() === "changes")
        )
          setGraph(next);
        if (view() === "changes")
          setActivity(
            props.architecture
              .check(observed, design)
              .map((diagnostic) => diagnostic.message)
              .join("\n") || "Changes since opening the workspace; no declared drift.",
          );
      }
    } catch (error) {
      setActivity(String(error));
    } finally {
      refreshBusy = false;
    }
  }
  async function acceptEvent(event: RuntimeEvent) {
    if (event.type === "tool-start") {
      setActivity(`Working: ${event.data.name}`);
      const args = event.data.arguments as Record<string, unknown> | undefined;
      const active = graph().nodes.find((node) => node.path === args?.path);
      if (active) navigation.setSelected(active.id);
    }
    if (event.type === "tool-end") {
      setActivity(`${event.data.name}: ${String(event.data.result).slice(0, 500)}`);
      const paths = event.data.changedPaths as string[] | undefined;
      if (paths) setTouched((previous) => new Set([...previous, ...paths]));
      if (
        ["architecture_propose", "architecture_preview"].includes(String(event.data.name)) &&
        !event.data.isError
      ) {
        const intended = (event.data.details as { intended?: ArchitectureGraph } | undefined)
          ?.intended;
        if (intended) {
          setPreview(event.data.name === "architecture_preview" ? intended : undefined);
          if (focus.layout() === "chat") focus.changeLayout("split");
          setView("intended");
          setGraph(intended);
          navigation.resetViewport();
          // Complete presentation before allowing the runtime's next mutation.
          await canvas.present();
        }
      }
    }
    if (event.type === "architecture" && view() !== "intended")
      setGraph(
        view() === "changes"
          ? diffGraph(baseline, event.data.graph as ArchitectureGraph)
          : (event.data.graph as ArchitectureGraph),
      );
    if (event.type === "usage") setUsage(usageLabel(event.data.total as Session["usage"]));
    if (event.type === "status")
      setActivity(`${event.data.status}${event.data.error ? ": " + event.data.error : ""}`);
    if (event.type === "compaction") setActivity("Context reduced; task ledger preserved.");
    if (event.type === "subagent")
      setActivity(`Subagent: ${event.data.status ?? event.data.type ?? "exploring"}`);
  }
  async function submit(prompt: string) {
    if (commands.working()) {
      setActivity("Updating the workspace. Please wait for it to finish.");
      return;
    }
    if (navigation.searching()) {
      navigation.applySearch(prompt);
      focus.clearInput();
      return;
    }
    if (!prompt.trim()) return;
    if (prompt.trim().startsWith("/")) {
      focus.clearInput();
      await commands.execute(prompt);
      return;
    }
    if (task.running()) {
      setActivity("Response still running; draft kept. Ctrl+C stops it.");
      return;
    }
    focus.clearInput();
    if (!commands.ready() || !props.run) {
      commands.open("connect");
      setActivity("Connect a provider and model with /connect before starting a task.");
      return;
    }
    if (focus.layout() === "architecture") focus.changeLayout("split");
    focus.returnToInput();
    await task.start(prompt.trim());
  }
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (task.running()) task.cancel();
      else renderer.destroy();
      return;
    }
    if (task.approval()) {
      key.preventDefault();
      if (key.name === "y" || key.name === "n") task.approve(key.name === "y");
      return;
    }
    if (commands.handleKey(key) || focus.handleKey(key)) return;
    navigation.handleKey(key);
  });
  usePaste((event) => {
    commands.handlePaste(event);
  });
  onMount(() => {
    const interval = setInterval(() => {
      if (!task.running()) void refresh();
    }, 2_500);
    onCleanup(() => clearInterval(interval));
  });
  return {
    commands,
    view,
    usage,
    graph,
    treeWidth,
    inspectorWidth,
    canvasWidth,
    narrow,
    touched,
    activity,
    conversation,
    submit,
    ...canvas,
    ...focus,
    selectAt: (event: Parameters<typeof canvas.selectAt>[0]) => {
      focus.returnToInput();
      canvas.selectAt(event);
    },
    running: task.running,
    approval: task.approval,
    visibleNodes: navigation.visibleNodes,
    selected: navigation.selected,
    setSelected: navigation.setSelected,
    setCanvasFocus: navigation.setCanvasFocus,
    collapsed: navigation.collapsed,
    selectNode: (id: string) => {
      focus.returnToInput();
      navigation.selectNode(id);
    },
    canvasFocus: navigation.canvasFocus,
    narrowPanel: navigation.narrowPanel,
    selectedNode: navigation.selectedNode,
    searching: navigation.searching,
  };
}
function usageLabel(usage: Session["usage"]) {
  return `${usage.input + usage.output} tokens · ${usage.cached} cached`;
}
export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
