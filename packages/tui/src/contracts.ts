import type {
  ArchitectureGraph,
  ArchitectureService,
  PermissionMode,
  RuntimeEvent,
  Session,
  ToolDefinition,
} from "@vcli/core";
export interface WorkspaceOptions {
  root: string;
  graph: ArchitectureGraph;
  architecture: ArchitectureService;
  permission: PermissionMode;
  renderer: "auto" | "kitty" | "sixel" | "blocks" | "off";
  run?: (
    prompt: string,
    signal: AbortSignal,
    emit: (event: RuntimeEvent) => void | Promise<void>,
    approve: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>,
  ) => Promise<Session>;
}
