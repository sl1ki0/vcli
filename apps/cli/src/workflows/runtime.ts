import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type ProviderAdapter,
  type RuntimeEvent,
  type SessionStore,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "@vcli/core";
import { createCheckpointTools } from "../tools/checkpoints.ts";
import { createSubagentTool } from "../tools/subagents.ts";
import { createTaskTools } from "../tools/tasks.ts";
import { CheckpointService } from "./checkpoints.ts";
import { loadProjectHooks } from "./hooks.ts";
import { createMemoryTools, loadProjectMemory } from "./memory.ts";
import { SubagentService } from "./subagents.ts";
import { LocalTaskStore } from "./tasks.ts";

interface LocalWorkflowOptions {
  root: string;
  registry: ToolRegistry;
  provider: ProviderAdapter;
  architecture: ArchitectureService;
  store: SessionStore;
  permissions: PermissionGate;
  runtime(): AgentRuntime;
  emit?: (event: RuntimeEvent) => void | Promise<void>;
}

/** Assemble local capabilities without coupling the portable runtime to disk or subprocesses. */
export async function createLocalWorkflows(options: LocalWorkflowOptions) {
  const { root, registry, store, permissions } = options;
  let memory = await loadProjectMemory(root);
  let hooks = await loadProjectHooks(root, permissions);
  const checkpoints = new CheckpointService(root);
  const emitChild = async (data: Record<string, unknown>, sessionId: string) => {
    const event: RuntimeEvent = {
      type: "subagent",
      sessionId,
      time: new Date().toISOString(),
      data,
    };
    await store.append(event);
    await options.emit?.(event);
  };
  const subagents = new SubagentService({
    reserve: async (_parent, tokens) => {
      const reservation = await options.runtime().reserveDelegation(tokens);
      return {
        tokens: reservation.tokens,
        settle: async (child) => {
          await reservation.settle(child);
          const parent = options.runtime().currentSession!;
          const event: RuntimeEvent = {
            type: "usage",
            sessionId: parent.id,
            time: new Date().toISOString(),
            data: {
              usage: child?.usage ?? { input: 0, output: 0, cached: 0 },
              total: parent.usage,
              delegated: true,
            },
          };
          await store.append(event);
          await options.emit?.(event);
        },
      };
    },
    onEvent: (update) => emitChild({ ...update }, update.parentSessionId),
    createRuntime: ({ settings, onEvent }) => {
      const reads = new ToolRegistry();
      for (const name of [
        "files_read",
        "files_search",
        "files_list",
        "architecture_query",
        "artifacts_read",
      ]) {
        const tool = registry.get(name);
        if (tool?.kind === "read") reads.register({ ...tool, eager: true });
      }
      return new AgentRuntime({
        root,
        provider: options.provider,
        architecture: options.architecture,
        store,
        tools: reads,
        permissions: new PermissionGate("read-only"),
        settings,
        onEvent,
        instructions: memory.text,
        mode: "plan",
      });
    },
  });
  for (const tool of [
    ...createMemoryTools(),
    ...createTaskTools(new LocalTaskStore(root)),
    ...createCheckpointTools(checkpoints),
    createSubagentTool(subagents),
  ])
    registry.register(tool);

  async function executeTool(
    call: ToolCall,
    context: ToolContext,
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    await hooks.beforeTool(call, context);
    const checkpoint = await checkpoints.before(call, context);
    let result: ToolResult;
    try {
      result = await execute();
    } catch (error) {
      try {
        await checkpoints.after(checkpoint);
      } catch {
        /* Keep the original tool failure. */
      }
      if (checkpoint)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nFile mutation outcome may be uncertain. Inspect the file and checkpoint before retrying; do not replay automatically.`,
        );
      throw error;
    }
    // A bookkeeping failure must never disguise a completed edit as a failed mutation.
    const warnings: string[] = [];
    try {
      await checkpoints.after(checkpoint, result);
    } catch {
      warnings.push(
        "Checkpoint finalization failed; inspect the file before retrying. Do not replay the edit.",
      );
    }
    const reports = await hooks.afterTool(call, result, context);
    for (const report of reports)
      if (report.status !== "success")
        warnings.push(
          `After-tool hook ${report.name}: ${report.status}. Tool outcome is unchanged. ${report.output}`,
        );
    const suffix = warnings.length ? `\n${warnings.join("\n")}` : "";
    return {
      ...result,
      text: result.text + suffix,
      fullOutput: (result.fullOutput ?? result.text) + suffix,
    };
  }
  return {
    instructions: async () => {
      memory = await loadProjectMemory(root);
      hooks = await loadProjectHooks(root, permissions);
      return memory.text;
    },
    serialTools: () => hooks.hasHooks,
    diagnostics: memory.diagnostics,
    executeTool,
  };
}
