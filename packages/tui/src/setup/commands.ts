import type { PermissionMode } from "@vcli/core";
import type { PanelChoice, WorkspacePanel } from "./contracts.ts";

export const workspaceCommandList = [
  { command: "/plan", description: "Read-only planning; show|visual|approve|reject saved plan" },
  { command: "/build", description: "Enable implementation under the current permission mode" },
  { command: "/memory", description: "Inspect loaded project instructions and memory" },
  { command: "/tasks", description: "Inspect persistent tasks and dependencies" },
  {
    command: "/checkpoints",
    description: "List recoverable file edits; /rewind <id> restores one",
  },
  { command: "/hooks", description: "Inspect configured tool hooks" },
  { command: "/connect", description: "Choose provider, model, endpoint and API key" },
  { command: "/open", description: "Open a project folder" },
  { command: "/tokens", description: "Edit context and task token budgets" },
  { command: "/reasoning", description: "Choose model reasoning effort" },
  { command: "/chat", description: "Full-screen chat; hide architecture (F2)" },
  { command: "/split", description: "Show architecture and chat together" },
  { command: "/architecture", description: "Full-screen architecture (F3)" },
  { command: "/config", description: "Review connection and settings" },
  { command: "/permission", description: "Change YOLO, ask or read-only during a task (Ctrl+P)" },
  { command: "/history", description: "Browse and resume saved conversations" },
  { command: "/new", description: "Start a new conversation" },
  { command: "/plugins", description: "List installed plugins" },
  { command: "/skills", description: "List available skills" },
  { command: "/view", description: "Architecture view: observed|intended|changes" },
  { command: "/scan", description: "Refresh source architecture" },
  { command: "/rewind", description: "Restore a file checkpoint by ID" },
  { command: "/stop", description: "Cancel the active response or tool without closing chat" },
  { command: "/exit", description: "Cancel active work, save the conversation and exit CLI" },
  { command: "/help", description: "Open the command menu (F1)" },
] as const;

interface MenuActions {
  emptyProject: boolean;
  execute(command: string): Promise<boolean>;
  cancel(): void;
  setPermission(mode: PermissionMode): Promise<void>;
}

export function workspaceMenu(
  panel: WorkspacePanel | undefined,
  actions: MenuActions,
): PanelChoice[] {
  const command = (label: string, name: string, detail?: string): PanelChoice => ({
    label,
    detail,
    select: () => actions.execute(name).then(() => {}),
  });
  switch (panel) {
    case "welcome": {
      const open = command("Open project", "/open");
      const connect = command("Connect provider", "/connect");
      return [
        ...(actions.emptyProject ? [open, connect] : [connect, open]),
        command("Token budgets", "/tokens"),
        command("Help / commands", "/help"),
        { label: "Explore current folder (Esc)", select: actions.cancel },
      ];
    }
    case "help":
      return workspaceCommandList.map((item) =>
        command(item.command, item.command, item.description),
      );
    case "config":
      return [
        command("Connection", "/connect"),
        command("Token budgets", "/tokens"),
        command("Reasoning effort", "/reasoning"),
        command("Permission mode", "/permission"),
        command("Open project", "/open"),
        command("Help / commands", "/help"),
      ];
    case "permission":
      return [
        {
          label: "YOLO",
          detail: "Agent can change files and execute commands without approval.",
          select: () => actions.setPermission("yolo"),
        },
        {
          label: "Ask",
          detail: "Approve writes and commands before they execute.",
          select: () => actions.setPermission("ask"),
        },
        {
          label: "Read-only",
          detail: "Allow reads; deny writes and commands.",
          select: () => actions.setPermission("read-only"),
        },
      ];
    default:
      return [];
  }
}
