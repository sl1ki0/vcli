import { createSignal } from "solid-js";
import type { ToolDefinition } from "@vcli/core";
import type { WorkspaceInspection, WorkspaceOptions } from "./contracts.ts";

interface WorkflowActions {
  workspace: WorkspaceOptions;
  canChange(): boolean;
  cancel(): void;
  activity(text: string): void;
  feedback(text: string): void;
  working(value: boolean): void;
  inspect(topic: WorkspaceInspection): Promise<void>;
  refresh(): Promise<void>;
  approve?: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>;
}

/** Local workflow commands do not submit hidden prompts or spend model tokens. */
export function createWorkflowCommands(actions: WorkflowActions) {
  const [mode, setMode] = createSignal(actions.workspace.mode ?? "build");
  function restoreMode(next: "build" | "plan") {
    actions.workspace.changeMode?.(next);
    setMode(next);
  }
  async function execute(name: string, args: string[]): Promise<boolean> {
    if (name === "/plan" || name === "/build") {
      if (actions.canChange()) {
        const next = name === "/plan" ? "plan" : "build";
        restoreMode(next);
        actions.cancel();
        actions.activity(
          next === "plan"
            ? "Plan mode: explore and design without source edits. Send your planning request; /build enables implementation."
            : "Build mode: ready to implement. Send a task or ask to implement the plan.",
        );
      }
      return true;
    }
    const inspectors: Record<string, WorkspaceInspection> = {
      "/memory": "memory",
      "/tasks": "tasks",
      "/checkpoints": "checkpoints",
      "/hooks": "hooks",
      "/plans": "plan",
    };
    if (inspectors[name]) {
      await actions.inspect(inspectors[name]);
      return true;
    }
    if (name !== "/rewind") return false;
    if (!actions.canChange()) return true;
    if (!args[0]) {
      await actions.inspect("checkpoints");
      return true;
    }
    actions.working(true);
    try {
      if (!actions.workspace.rewind) throw new Error("Checkpoint restore is unavailable.");
      actions.activity(
        await actions.workspace.rewind(args[0], actions.approve ?? (async () => false)),
      );
      await actions.refresh();
    } catch (error) {
      actions.feedback(error instanceof Error ? error.message : String(error));
    } finally {
      actions.working(false);
    }
    return true;
  }
  return { mode, execute, restoreMode };
}
