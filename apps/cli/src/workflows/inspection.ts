import { RootedFileSystem } from "./rooted-filesystem.ts";
import { PermissionGate, type PermissionMode, type Session, type ToolDefinition } from "@vcli/core";
import { createCheckpointTools } from "../tools/checkpoints.ts";
import { CheckpointService } from "./checkpoints.ts";
import { loadProjectMemory } from "./memory.ts";
import { loadProjectHooks } from "./hooks.ts";
import { formatRunPlan, readPlans } from "./plans.ts";
import { LocalTaskStore } from "./tasks.ts";

export type WorkflowInspection = "memory" | "tasks" | "checkpoints" | "hooks" | "plan";
export async function inspectWorkflow(
  root: string,
  topic: WorkflowInspection,
  session?: Session,
): Promise<string> {
  switch (topic) {
    case "memory": {
      const memory = await loadProjectMemory(root);
      return [
        memory.text || "No project instructions yet. Add AGENTS.md, CLAUDE.md or .vcli/MEMORY.md.",
        ...memory.diagnostics,
      ].join("\n");
    }
    case "tasks": {
      const tasks = await new LocalTaskStore(root).list();
      const active = session?.plan
        ? `Run ${session.id} · ${session.plan.status}\n${session.plan.steps
            .map(
              (task) =>
                `${task.id} · ${task.status}\n${task.description}\nDependencies: ${task.dependencies.join(", ") || "none"}\nReady when: ${task.doneWhen}\nVerified calls: ${task.verifiedBy?.join(", ") || "none"}`,
            )
            .join("\n\n")}`
        : "";
      return (
        [
          active,
          tasks
            .map(
              (task) =>
                `${task.id} · ${task.status}\n${task.title}\n${task.description}\nDependencies: ${task.dependencies.join(", ") || "none"}`,
            )
            .join("\n\n"),
        ]
          .filter(Boolean)
          .join("\n\n") || "No tasks yet. Ask the agent to create and track a task list."
      );
    }
    case "checkpoints": {
      const checkpoints = await new CheckpointService(root).list();
      return (
        checkpoints
          .map((item) => `${item.id} · ${item.status}\n${item.path} · ${item.createdAt}`)
          .join("\n\n") ||
        "No file edit checkpoints yet. Built-in file edits are captured automatically; shell and MCP effects are not."
      );
    }
    case "hooks": {
      const hooks = await loadProjectHooks(root, new PermissionGate("read-only"));
      if (!hooks.hasHooks)
        return "No command hooks configured. Add .vcli/hooks.json; see docs/local-workflows.md.";
      const filesystem = new RootedFileSystem(root, {
        allowProtectedPaths: true,
      });
      try {
        return filesystem.readText(".vcli/hooks.json", 65_536);
      } finally {
        filesystem.close();
      }
    }
    case "plan":
      return session?.plan ? formatRunPlan(session.plan, session.id) : readPlans(root);
  }
}

export async function rewindCheckpoint(
  root: string,
  id: string,
  permission: PermissionMode,
  approve?: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>,
): Promise<string> {
  const tool = createCheckpointTools(new CheckpointService(root)).find(
    (item) => item.name === "checkpoint_restore",
  )!;
  const args = { id };
  await new PermissionGate(permission, approve).authorize(tool, args);
  const result = await tool.execute(args, {
    root,
    sessionId: "manual",
    signal: new AbortController().signal,
  });
  return result.text;
}
