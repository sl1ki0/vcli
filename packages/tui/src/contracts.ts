import type {
  ArchitectureGraph,
  ArchitectureService,
  ContextSettings,
  PermissionMode,
  RuntimeEvent,
  Session,
  ToolDefinition,
} from "@vcli/core";

export type WorkspaceProvider = "openai" | "anthropic" | "gemini" | "compatible";
export interface WorkspaceSettings {
  provider: WorkspaceProvider;
  model: string;
  baseURL?: string;
  credential: "environment" | "saved" | "session" | "missing" | "not-required";
  permission: PermissionMode;
  contextWindow: number;
  context: ContextSettings;
}
export type WorkspaceSettingsUpdate =
  | {
      kind: "connection";
      provider: WorkspaceProvider;
      model: string;
      baseURL?: string;
      apiKey?: string;
      saveKey: boolean;
    }
  | { kind: "budgets"; contextWindow: number; context: ContextSettings }
  | { kind: "permission"; permission: PermissionMode };

/** Only explicit, credential-free validation errors may be shown during key setup. */
export class WorkspaceSettingsError extends Error {
  constructor(
    readonly field: "model" | "endpoint" | "key" | "budgets",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceSettingsError";
  }
}

export interface WorkspaceOptions {
  root: string;
  graph: ArchitectureGraph;
  architecture: ArchitectureService;
  permission: PermissionMode;
  renderer: "auto" | "kitty" | "sixel" | "blocks" | "off";
  settings?: WorkspaceSettings;
  configure?: (update: WorkspaceSettingsUpdate) => Promise<WorkspaceSettings>;
  openProject?: (path: string) => Promise<void>;
  inspect?: (topic: "sessions" | "plugins" | "skills") => Promise<string>;
  initialCommand?: "/connect" | "/tokens" | "/help" | "/config" | "/open";
  run?: (
    prompt: string,
    signal: AbortSignal,
    emit: (event: RuntimeEvent) => void | Promise<void>,
    approve: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>,
  ) => Promise<Session>;
}
