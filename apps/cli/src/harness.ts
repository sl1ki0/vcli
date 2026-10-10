import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type RuntimeEvent,
  type Session,
  type ToolDefinition,
} from "@vcli/core";
import { createProvider } from "@vcli/providers";
import { discoverSkills, loadSkill, McpManager, PluginManager } from "@vcli/integrations";
import { configHome, type Config } from "./config.ts";
import { registerBuiltins } from "./builtin-tools.ts";
import { SqliteSessionStore } from "./store.ts";

export async function createHarness(
  root: string,
  config: Config,
  architecture: ArchitectureService,
  emit?: (event: RuntimeEvent) => void | Promise<void>,
  approve?: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<boolean>,
) {
  if (!config.model)
    throw new Error(
      "Select a model: vcli config set provider <provider>; vcli config set model <model-id>. Set its API key in the environment.",
    );
  const provider = createProvider(config);
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
  const permissions = new PermissionGate(config.permission, approve);
  let discovered = false;
  let runtime: AgentRuntime;
  registerBuiltins(registry, {
    architecture,
    store,
    skillList: () => skills.map((s) => ({ ...s, name: `${s.plugin}:${s.name}` })),
    loadSkill: (name) => loadSkill(name, skills),
    record: (values) => runtime.record(values),
    discover: async (_query, signal) => {
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
  runtime = new AgentRuntime({
    root,
    provider,
    tools: registry,
    architecture,
    store,
    permissions,
    settings: config.context,
    onEvent: emit,
  });
  return {
    runtime,
    store,
    mcp,
    registry,
    diagnostics,
    run: (prompt: string, signal: AbortSignal, resume?: string): Promise<Session> =>
      runtime.run(prompt, signal, resume),
    close: async () => {
      await mcp.disconnect();
      store.close();
    },
  };
}
