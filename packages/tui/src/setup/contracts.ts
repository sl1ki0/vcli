import type { Accessor } from "solid-js";
import type { WorkspaceSettings, WorkspaceSettingsUpdate } from "../contracts.ts";

export interface SetupHost {
  settings: Accessor<WorkspaceSettings | undefined>;
  apply(update: WorkspaceSettingsUpdate): Promise<void>;
  message(text: string): void;
}
export interface PanelChoice {
  label: string;
  detail?: string;
  select(): void | Promise<void>;
}
export interface PanelInput {
  label: string;
  value: string;
  placeholder: string;
  hint?: string;
}

export type WorkspacePanel =
  | "welcome"
  | "help"
  | "config"
  | "connect"
  | "tokens"
  | "permission"
  | "reasoning"
  | "history"
  | "open"
  | "status"
  | "plan"
  | "read";
