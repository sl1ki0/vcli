import { createSignal } from "solid-js";
import type { RunPlanState, Session, ToolDefinition } from "@vcli/core";
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
  plan(): RunPlanState | undefined;
  showPlan(visual: boolean): void;
  restoreSession(session: Session): void;
}

/** Local workflow commands do not submit hidden prompts or spend model tokens. */
export function createWorkflowCommands(actions: WorkflowActions) {
  const [mode, setMode] = createSignal(actions.workspace.mode ?? "build");
  function restoreMode(next: "build" | "plan") {
    actions.workspace.changeMode?.(next);
    setMode(next);
  }
  async function execute(name: string, args: string[]): Promise<boolean> {
    if (name === "/plan" && (args[0] === "approve" || args[0] === "reject")) {
      await decide(args[0] === "approve");
      return true;
    }
    if (
      (name === "/plans" || (name === "/plan" && ["show", "visual"].includes(args[0] ?? ""))) &&
      actions.plan()
    ) {
      actions.showPlan(args[0] === "visual");
      return true;
    }
    if (name === "/plan" && ["show", "visual"].includes(args[0] ?? "")) {
      await actions.inspect("plan");
      return true;
    }
    if (name === "/plan" && args.length) {
      actions.feedback("Use /plan, /plan show, /plan visual, /plan approve or /plan reject.");
      return true;
    }
    if (name === "/plan" || name === "/build") {
      if (actions.canChange()) {
        if (name === "/build" && actions.plan()?.status === "draft") {
          await decide(true);
          return true;
        }
        if (name === "/build" && actions.plan()?.status === "rejected") {
          actions.feedback(
            "The plan was rejected. Publish a revised plan in /plan before building.",
          );
          return true;
        }
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
  async function decide(approved: boolean) {
    if (!actions.canChange()) return;
    if (actions.plan()?.status !== "draft") {
      actions.feedback("No draft plan is awaiting a decision.");
      return;
    }
    actions.working(true);
    try {
      if (!actions.workspace.decidePlan) throw new Error("Plan decisions are unavailable.");
      const session = await actions.workspace.decidePlan(approved);
      actions.restoreSession(session);
      restoreMode(approved ? "build" : "plan");
      actions.cancel();
      actions.activity(
        approved
          ? "Plan approved and saved. Send a message to implement it under the current permission mode."
          : "Plan rejected and saved. Planning remains read-only; send a request to revise it.",
      );
    } catch (error) {
      actions.feedback(error instanceof Error ? error.message : String(error));
    } finally {
      actions.working(false);
    }
  }
  return { mode, execute, restoreMode };
}
