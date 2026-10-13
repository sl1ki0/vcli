import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type RuntimeEvent,
  type Session,
  type ToolDefinition,
  type ApprovalDecision,
} from "@vcli/core";
import { createProvider } from "@vcli/providers";
import { discoverSkills, loadSkill, McpManager, PluginManager } from "@vcli/integrations";
import { configHome, type Config } from "./config.ts";
import { registerBuiltins } from "./builtin-tools.ts";
import { SqliteSessionStore } from "./store.ts";
import { resolveCredential } from "./credentials.ts";
import { createLocalWorkflows } from "./workflows/runtime.ts";
import { savePlan } from "./workflows/plans.ts";

export interface HarnessOptions {
  apiKey?: string;
  mode?: "build" | "plan";
}

export async function createHarness(
  root: string,
  config: Config,
  architecture: ArchitectureService,
  emit?: (event: RuntimeEvent) => void | Promise<void>,
  approve?: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<ApprovalDecision>,
  options: HarnessOptions = {},
) {
  if (!config.model)
    throw new Error(
      "Select a provider and model with vcli setup or /connect. For shell setup, use vcli config set provider <provider> and vcli config set model <model-id>.",
    );
  const credential = await resolveCredential(config, options.apiKey);
  if (credential.status === "missing")
    throw new Error(
      `No ${config.provider} API key configured. Add it with vcli setup or /connect, or set the provider environment variable.`,
    );
  const provider = createProvider({ ...config, apiKey: credential.apiKey });
  const store = await SqliteSessionStore.open(root);
  const registry = new ToolRegistry();
  const manager = new PluginManager(join(configHome(), "extensions"));
  let plugins;
  try {
    plugins = await manager.list();
  } catch (error) {
    store.close();
    throw error;
  }
  const diagnostics: string[] = [];
  const localSkills = await discoverSkills(
    root,
    [".vcli/skills", ".agents/skills", ".claude/skills", ".gemini/skills"],
    "project",
    diagnostics,
  );
  const skills = [...localSkills, ...plugins.flatMap((p) => p.skills)];
  const servers = [
    ...config.mcpServers,
    ...plugins.flatMap((p) => p.servers.map((s) => ({ ...s, name: `${p.name}.${s.name}` }))),
  ];
  const mcp = new McpManager(servers);
  const permissions = new PermissionGate(
    options.mode === "plan" ? "read-only" : config.permission,
    approve,
  );
  let discovered = false;
  let runtime: AgentRuntime;
  registerBuiltins(registry, {
    architecture,
    store,
    skillList: () => skills.map((s) => ({ ...s, name: `${s.plugin}:${s.name}` })),
    loadSkill: (name) => loadSkill(name, skills),
    record: (values) => runtime.record(values),
    discover: async (_query, signal) => {
      // Local deferred tools remain discoverable when external execution is disabled.
      if (permissions.mode === "read-only") return;
      if (discovered || !servers.length) return;
      await permissions.authorize(
        {
          name: "mcp_connect",
          description: "Start configured MCP server programs or connect to external servers",
          kind: "execute",
          inputSchema: {},
          execute: async () => ({ text: "connected" }),
        },
        { servers: servers.map((s) => ({ name: s.name, type: s.type, command: s.command })) },
      );
      signal.throwIfAborted();
      const tools = await mcp.discover(undefined, signal);
      signal.throwIfAborted();
      for (const tool of tools) registry.register(tool);
      discovered = true;
    },
  });
  let workflows;
  try {
    workflows = await createLocalWorkflows({
      root,
      registry,
      provider,
      architecture,
      store,
      permissions,
      runtime: () => runtime,
      emit,
    });
  } catch (error) {
    await mcp.disconnect();
    store.close();
    throw error;
  }
  diagnostics.push(...workflows.diagnostics);
  runtime = new AgentRuntime({
    root,
    provider,
    tools: registry,
    architecture,
    store,
    permissions,
    settings: config.context,
    onEvent: emit,
    mode: options.mode,
    instructions: workflows.instructions,
    executeTool: workflows.executeTool,
    serialTools: workflows.serialTools,
  });
  return {
    runtime,
    store,
    mcp,
    registry,
    diagnostics,
    run: async (prompt: string, signal: AbortSignal, resume?: string): Promise<Session> => {
      const session = await runtime.run(prompt, signal, resume);
      await savePlan(root, session);
      return session;
    },
    close: async () => {
      await mcp.disconnect();
      store.close();
    },
  };
}
