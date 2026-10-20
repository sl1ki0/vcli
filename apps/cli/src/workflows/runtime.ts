import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type ProviderAdapter,
  type RuntimeEvent,
  type SessionStore,
} from "@vcli/core";
import { createCheckpointTools } from "../tools/checkpoints.ts";
import { createSubagentTool } from "../tools/subagents.ts";
import { createTaskTools } from "../tools/tasks.ts";
import { createMemoryTools, loadProjectMemory } from "./memory.ts";
import { SubagentService } from "./subagents.ts";
import { LocalTaskStore } from "./tasks.ts";
import { createPlanTools } from "../tools/plans.ts";
import { ProjectToolExecutor } from "./tool-execution.ts";

interface LocalWorkflowOptions {
  root: string;
  registry: ToolRegistry;
  provider: ProviderAdapter;
  architecture: ArchitectureService;
  store: SessionStore;
  permissions: PermissionGate;
  runtime(): AgentRuntime;
  emit?: (event: RuntimeEvent) => void | Promise<void>;
  policyPath?: string;
  stateDirectory?: string;
  externalStartup?: () => { count: number; description: string };
}

/** Assemble local capabilities without coupling the portable runtime to disk or subprocesses. */
export async function createLocalWorkflows(options: LocalWorkflowOptions) {
  const { root, registry, store } = options;
  const executor = await ProjectToolExecutor.create(options);
  const { policy } = executor;
  let memory = await loadProjectMemory(root);
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
        runLimits: reservation.runLimits,
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
    createRuntime: ({ settings, onEvent, runLimits }) => {
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
        runLimits,
        onEvent,
        instructions: memory.text,
        mode: "build",
        executionPolicy: options.policyPath ? { path: options.policyPath } : undefined,
        beforeTool: async (call, context) => {
          await policy.assertTool(call, context);
          context.authorizePath = (path, write) =>
            policy.resolvePath(path, { write, allowRoot: true });
        },
      });
    },
  });
  for (const tool of [
    ...createPlanTools({
      getSession: () => options.runtime().currentSession,
      save: (session) => store.save(session),
      hasTool: (name) => Boolean(registry.get(name)),
      emit: async (event) => {
        await store.append(event);
        await options.emit?.(event);
      },
    }),
    ...createMemoryTools(),
    ...createTaskTools(new LocalTaskStore(root)),
    ...createCheckpointTools(executor.checkpoints),
    createSubagentTool(subagents),
  ])
    registry.register(tool);

  return {
    instructions: async () => {
      memory = await loadProjectMemory(root);
      await executor.reloadHooks();
      return memory.text;
    },
    serialTools: executor.serialTools,
    diagnostics: memory.diagnostics,
    executeTool: executor.executeTool,
    sideEffectCost: executor.sideEffectCost,
    beforeTool: executor.beforeTool,
    inspectUncertain: executor.inspectUncertain,
    policy,
    journal: executor.journal,
  };
}
