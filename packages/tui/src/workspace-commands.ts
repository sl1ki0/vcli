import type { KeyEvent, PasteEvent } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import type { ArchitectureGraph, PermissionMode, Session, ToolDefinition } from "@vcli/core";
import type {
  WorkspaceOptions,
  WorkspaceSettingsUpdate,
  WorkspaceInspection,
} from "./contracts.ts";
import { createConnectionSetup } from "./setup/connection.ts";
import { createBudgetSetup } from "./setup/budgets.ts";
import type { PanelChoice, PanelInput, WorkspacePanel } from "./setup/contracts.ts";
import { workspaceMenu } from "./setup/commands.ts";
import { createReasoningSetup, reasoningChoices } from "./setup/reasoning.ts";
import { createSessionHistory } from "./chat/history.ts";
import { createWorkflowCommands } from "./workflow-commands.ts";
export type WorkspaceLayout = "chat" | "split" | "architecture";

type GraphView = "observed" | "intended" | "changes";
interface CommandOptions {
  workspace: WorkspaceOptions;
  graph: Accessor<ArchitectureGraph>;
  running: Accessor<boolean>;
  activity(text: string): void;
  refresh(): Promise<void>;
  changeView(view: GraphView): Promise<void>;
  close(): void;
  changeLayout(layout: WorkspaceLayout): void;
  restoreSession(session: Session): void;
  clearConversation(): void;
  approve?: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>;
}
export function createWorkspaceCommands(options: CommandOptions) {
  const props = options.workspace;
  const [settings, setSettings] = createSignal(props.settings);
  const emptyProject = createMemo(
    () =>
      !options.graph().nodes.some((node) => node.kind !== "package" && node.kind !== "external"),
  );
  const ready = createMemo(() =>
    settings()
      ? Boolean(settings()!.model.trim()) && settings()!.credential !== "missing"
      : Boolean(props.run),
  );
  const [panel, setPanel] = createSignal<WorkspacePanel | undefined>(
    emptyProject() || (props.settings && !ready()) ? "welcome" : undefined,
  );
  const [message, setMessage] = createSignal("");
  const [working, setWorking] = createSignal(false);
  const [choice, setChoice] = createSignal(0);
  const [openPath, setOpenPath] = createSignal(props.root);
  const [readTitle, setReadTitle] = createSignal("");
  const [readContent, setReadContent] = createSignal("");
  let readVersion = 0;
  const feedback = (text: string) => {
    setMessage(text);
    if (text) options.activity(text);
  };
  const connection = createConnectionSetup({ settings, apply, message: feedback });
  const budgets = createBudgetSetup({ settings, apply, message: feedback });
  const reasoning = createReasoningSetup({ settings, apply, message: feedback });
  const history = createSessionHistory({
    workspace: props,
    canChange,
    close: () => cancel(true),
    activity: options.activity,
    restore: (session) => {
      workflows.restoreMode(session.mode ?? "build");
      options.restoreSession(session);
    },
    clear: options.clearConversation,
  });

  function cancel(force = false) {
    if (history.selecting() && !force) {
      feedback("Opening the conversation. Please wait for it to finish.");
      return;
    }
    connection.clear();
    ++readVersion;
    history.invalidate();
    setPanel(undefined);
    setMessage("");
  }
  function canChange() {
    if (!options.running() && !working() && !history.selecting()) return true;
    feedback("Stop the active task before changing settings or opening another project.");
    return false;
  }
  function open(kind: WorkspacePanel) {
    if (history.selecting()) {
      feedback("Opening the conversation. Please wait for it to finish.");
      return;
    }
    if (
      ["connect", "tokens", "permission", "reasoning", "history", "open", "config"].includes(
        kind,
      ) &&
      !canChange()
    )
      return;
    connection.clear();
    ++readVersion;
    setMessage("");
    setChoice(0);
    if (kind === "connect") connection.begin();
    if (kind === "tokens") budgets.begin();
    if (kind === "open") setOpenPath(props.root);
    setPanel(kind);
    if (kind === "history") void history.load();
  }
  async function apply(update: WorkspaceSettingsUpdate) {
    if (!canChange()) throw new Error("Active task must finish first.");
    if (!props.configure) throw new Error("Settings are unavailable in this workspace.");
    setWorking(true);
    try {
      setSettings(await props.configure(update));
      cancel();
      const label =
        update.kind === "connection"
          ? "Connection saved"
          : update.kind === "budgets"
            ? "Token budgets saved"
            : update.kind === "reasoning"
              ? "Reasoning effort saved"
              : "Permission mode saved";
      options.activity(
        update.kind === "connection" && settings()?.credential === "missing"
          ? "Provider/model saved. No API key found; use /connect to add one before starting a task."
          : `${label}. Project settings updated.`,
      );
    } finally {
      setWorking(false);
    }
  }
  async function setPermission(permission: PermissionMode) {
    try {
      await apply({ kind: "permission", permission });
    } catch (error) {
      feedback(error instanceof Error ? error.message : "Could not save permission mode.");
    }
  }
  async function openProject(path: string) {
    if (!canChange()) return;
    if (!path.trim()) {
      feedback("Enter a project folder path.");
      return;
    }
    setOpenPath(path.trim());
    setWorking(true);
    try {
      if (!props.openProject)
        throw new Error("Opening another project is unavailable in this workspace.");
      await props.openProject(path.trim());
      connection.clear();
      options.close();
    } catch (error) {
      feedback(error instanceof Error ? error.message : "Could not open this project.");
    } finally {
      setWorking(false);
    }
  }
  async function inspect(topic: WorkspaceInspection) {
    open("read");
    setReadTitle(topic[0]!.toUpperCase() + topic.slice(1));
    setReadContent("Loading local records…");
    const request = ++readVersion;
    try {
      const content = props.inspect
        ? await props.inspect(topic)
        : `No ${topic} inspector configured.`;
      if (request === readVersion) setReadContent(content.slice(0, 30_000));
    } catch (error) {
      if (request === readVersion) setReadContent(String(error));
    }
  }
  const workflows = createWorkflowCommands({
    workspace: props,
    canChange,
    cancel,
    inspect,
    feedback,
    activity: options.activity,
    working: setWorking,
    refresh: options.refresh,
    approve: options.approve,
  });
  async function execute(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt.startsWith("/")) return false;
    if (history.selecting()) {
      feedback("Opening the conversation. Please wait for it to finish.");
      return true;
    }
    const [name, ...args] = prompt.split(/\s+/);
    if (await workflows.execute(name!, args)) return true;
    if (name === "/help" || name === "/commands") open("help");
    else if (name === "/connect") open("connect");
    else if (name === "/tokens") open("tokens");
    else if (name === "/reasoning") {
      const effort = reasoningChoices.find((item) => item.value === args[0]);
      if (effort) await reasoning.save(effort.value);
      else {
        open("reasoning");
        if (args.length) feedback("Choose a supported reasoning effort below.");
      }
    } else if (name === "/chat" || name === "/split" || name === "/architecture") {
      cancel();
      options.changeLayout(name.slice(1) as WorkspaceLayout);
    } else if (name === "/history" || name === "/sessions") {
      if (props.sessions) open("history");
      else await inspect("sessions");
    } else if (name === "/new") await history.create();
    else if (name === "/config") open("config");
    else if (name === "/status") open("status");
    else if (name === "/permission") {
      const mode = args[0];
      if (mode && ["yolo", "ask", "read-only"].includes(mode))
        await setPermission(mode as PermissionMode);
      else open("permission");
    } else if (name === "/open") {
      open("open");
      if (args.length && canChange()) await openProject(args.join(" "));
    } else if (name === "/plugins" || name === "/skills")
      await inspect(name.slice(1) as "plugins" | "skills");
    else if (name === "/observed" || name === "/intended" || name === "/changes") {
      cancel();
      await options.changeView(name.slice(1) as GraphView);
    } else if (name === "/scan") {
      cancel();
      await options.refresh();
    } else {
      open("help");
      feedback(`Unknown command ${name}. Choose a command below.`);
    }
    return true;
  }
  function choices(): PanelChoice[] {
    if (panel() === "connect") return connection.choices();
    if (panel() === "tokens") return budgets.choices();
    if (panel() === "reasoning") return reasoning.choices();
    if (panel() === "history") return history.choices();
    return workspaceMenu(panel(), { emptyProject: emptyProject(), execute, cancel, setPermission });
  }
  const input = createMemo<PanelInput | undefined>(() =>
    panel() === "connect"
      ? connection.input()
      : panel() === "tokens"
        ? budgets.input()
        : panel() === "open"
          ? { label: "Folder path", value: openPath(), placeholder: "Path to a project folder" }
          : undefined,
  );
  async function submitInput(text: string) {
    if (working()) return;
    if (panel() === "connect") connection.submit(text);
    if (panel() === "tokens") budgets.submit(text);
    if (panel() === "open") await openProject(text);
  }
  function handleKey(key: KeyEvent) {
    if (key.name === "f1") {
      key.preventDefault();
      open("help");
      return true;
    }
    if (!panel()) return false;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      if (!working()) cancel();
      return true;
    }
    if (working() || (panel() === "history" && history.loading())) {
      key.preventDefault();
      key.stopPropagation();
      return true;
    }
    if (panel() === "connect" && connection.handleKey(key)) return true;
    if (input()) return true; // Native Input handles only non-secret fields.
    const items = choices();
    if (!items.length) return true;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "up" || key.name === "down")
      setChoice(
        (previous) => (previous + (key.name === "up" ? -1 : 1) + items.length) % items.length,
      );
    else if (key.name === "return") void items[choice()]?.select();
    else if (/^[1-9]$/.test(key.sequence)) void items[Number(key.sequence) - 1]?.select();
    return true;
  }
  function handlePaste(event: PasteEvent) {
    return panel() === "connect" && connection.handlePaste(event);
  }
  createEffect(() => {
    panel();
    connection.step();
    budgets.field();
    setChoice(0);
  });
  onMount(() => {
    if (props.initialCommand) void execute(props.initialCommand);
  });
  onCleanup(() => connection.clear());
  return {
    panel,
    settings,
    mode: workflows.mode,
    ready,
    emptyProject,
    working: () => working() || history.selecting(),
    message,
    choice,
    choices,
    input,
    connection,
    budgets,
    history,
    readTitle,
    readContent,
    open,
    cancel,
    execute,
    submitInput,
    handleKey,
    handlePaste,
  };
}
export type WorkspaceCommands = ReturnType<typeof createWorkspaceCommands>;
