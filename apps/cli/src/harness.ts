import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ArchitectureService,
  type RuntimeEvent,
  type Session,
  type ToolDefinition,
  type ApprovalDecision,
  type PermissionMode,
} from "@vcli/core";
import { createProvider } from "@vcli/providers";
import {
  discoverSkills,
  loadSkill,
  McpManager,
  PluginManager,
  projectSkillLocations,
} from "@vcli/integrations";
import { configHome, type Config } from "./config.ts";
import { registerBuiltins } from "./builtin-tools.ts";
import { SqliteSessionStore } from "./store.ts";
import { resolveCredential } from "./credentials.ts";
import { createLocalWorkflows } from "./workflows/runtime.ts";
import { savePlan } from "./workflows/plans.ts";
import { scopedArchitecture } from "./workflows/architecture-policy.ts";
import { sandboxedMcpTransport } from "./workflows/mcp-transport.ts";

export interface HarnessOptions {
  apiKey?: string;
  mode?: "build" | "plan";
  policyPath?: string;
  stateDirectory?: string;
  /** Resume policy is loaded before constructing any executor. */
  resumeId?: string;
}

export async function createHarness(
  root: string,
  config: Config,
  architecture: ArchitectureService,
  emit?: (event: RuntimeEvent) => void | Promise<void>,
  approve?: (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ApprovalDecision>,
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
  const store = await SqliteSessionStore.open(root, { directory: options.stateDirectory });
  const previous = options.resumeId ? await store.get(options.resumeId) : undefined;
  if (options.resumeId && !previous) {
    store.close();
    throw new Error(`Session not found: ${options.resumeId}`);
  }
  if (
    previous?.executionPolicy &&
    options.policyPath &&
    previous.executionPolicy.path !== options.policyPath
  ) {
    store.close();
    throw new Error("Resume must retain the policy file bound to this run.");
  }
  const policyPath = previous?.executionPolicy?.path ?? options.policyPath;
  architecture = scopedArchitecture(architecture, policyPath, options.stateDirectory);
  const registry = new ToolRegistry();
  const manager = new PluginManager(join(configHome(), "extensions"));
  let plugins;
  try {
    plugins = await manager.list({ workspaceRoot: root });
  } catch (error) {
    store.close();
    throw error;
  }
  const diagnostics: string[] = plugins.flatMap((plugin) =>
    plugin.unsupported.map((reason) => `Plugin ${plugin.name}: ${reason}`),
  );
  const localSkills = await discoverSkills(
    root,
    [...projectSkillLocations],
    "project",
    diagnostics,
  );
  const skills = [...localSkills, ...plugins.flatMap((p) => p.skills)];
  const servers = [...config.mcpServers, ...plugins.flatMap((p) => p.servers)];
  const startupContract = createHash("sha256").update(JSON.stringify(servers)).digest("hex");
  const mcp = new McpManager(servers, {
    stdioTransport: sandboxedMcpTransport(
      root,
      new Map(
        plugins.flatMap((plugin) => plugin.servers.map((server) => [server.name, plugin.root])),
      ),
    ),
  });
  const permissions = new PermissionGate(
    options.mode === "plan" ? "read-only" : config.permission,
    approve,
  );
  let discovered = false;
  registerBuiltins(registry, {
    architecture,
    store,
    skillList: () => skills.map((s) => ({ ...s, name: `${s.plugin}:${s.name}` })),
    loadSkill: (name) => loadSkill(name, skills),
    record: (values) => runtime.record(values),
    discover: async (_query, signal, context) => {
      // Local deferred tools remain discoverable when external execution is disabled.
      if (permissions.mode === "read-only" || runtime.currentSession?.mode === "plan") return;
      if (policyPath) return;
      if (discovered || !servers.length) return;
      const connectionTool: ToolDefinition = {
        name: "mcp_connect",
        description: "Start configured MCP server programs or connect to external servers",
        kind: "execute",
        inputSchema: {},
        execute: async () => ({ text: "connected" }),
      };
      if (context?.effectsAuthorized) permissions.assertAllowed(connectionTool);
      else
        await permissions.authorize(connectionTool, {
          servers: servers.map((s) => ({ name: s.name, type: s.type, command: s.command })),
        });
      signal.throwIfAborted();
      const tools = await mcp.discover(undefined, signal);
      signal.throwIfAborted();
      for (const tool of tools) {
        try {
          registry.register(tool);
        } catch {
          // Server-controlled compiler errors can contain schema text or secrets.
          diagnostics.push(`MCP tool ${tool.name} disabled: invalid tool schema`);
        }
      }
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
      policyPath,
      stateDirectory: options.stateDirectory,
      externalStartup: () => ({
        count:
          !policyPath &&
          permissions.mode !== "read-only" &&
          runtime.currentSession?.mode !== "plan" &&
          !discovered &&
          servers.length
            ? servers.length
            : 0,
        description: `Connect configured MCP servers: ${servers.map((server) => server.name).join(", ")} (contract ${startupContract})`,
      }),
    });
  } catch (error) {
    await mcp.disconnect();
    store.close();
    throw error;
  }
  diagnostics.push(...workflows.diagnostics);
  const runtime = new AgentRuntime({
    root,
    provider,
    tools: registry,
    architecture,
    store,
    permissions,
    settings: config.context,
    runLimits: config.runLimits,
    executionPolicy: policyPath ? { path: policyPath } : undefined,
    onEvent: emit,
    mode: options.mode,
    instructions: workflows.instructions,
    executeTool: workflows.executeTool,
    beforeTool: workflows.beforeTool,
    sideEffectCost: workflows.sideEffectCost,
    inspectUncertain: workflows.inspectUncertain,
    serialTools: workflows.serialTools,
  });
  return {
    runtime,
    store,
    mcp,
    registry,
    diagnostics,
    setPermission: (permission: PermissionMode) =>
      permissions.setMode(options.mode === "plan" ? "read-only" : permission),
    run: async (prompt: string, signal: AbortSignal, resume?: string): Promise<Session> => {
      const session = await runtime.run(prompt, signal, resume);
      await savePlan(root, session, { directory: options.stateDirectory });
      return session;
    },
    close: async () => {
      await mcp.disconnect();
      store.close();
    },
  };
}
