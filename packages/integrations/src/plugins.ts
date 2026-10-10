import { basename, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Plugin } from "@vcli/core";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { containedPath, exists, message, object, readJson, validateName } from "./paths.ts";
import { discoverSkills, readSkillMetadata } from "./skills.ts";
import { normalizeMcpServer } from "./mcp-config.ts";
import { pluginSchema } from "./schemas.ts";

export interface LoadPluginOptions {
  dataRoot?: string;
  workspaceRoot?: string;
  nameHint?: string;
}
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const portableKeys = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const schemaValidator = new AjvJsonSchemaValidator();
const validateManifest = schemaValidator.getValidator(pluginSchema as JsonSchemaType);

function portableManifest(manifest: Record<string, unknown>): void {
  validateName(manifest.name, "Plugin name");
  // The normative spec ignores unknown top-level fields and invalid/unknown extension values.
  const cleaned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => portableKeys.has(key) && key !== "extensions"),
  );
  const validation = validateManifest(cleaned);
  if (!validation.valid)
    throw new Error(`Invalid portable plugin manifest: ${validation.errorMessage}`);
}

function strings(value: unknown, label: string): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || !values.every((item) => typeof item === "string"))
    throw new Error(`${label} must be a path or array of paths`);
  return values;
}

async function readManifest(
  root: string,
  options: LoadPluginOptions,
): Promise<{ manifest: Record<string, unknown>; ecosystem: Plugin["ecosystem"] }> {
  let ecosystem: Plugin["ecosystem"] = "portable";
  let manifest: Record<string, unknown>;
  const candidates = [
    ["plugin.json", "portable"],
    [".claude-plugin/plugin.json", "claude"],
    [".codex-plugin/plugin.json", "codex"],
    ["gemini-extension.json", "gemini"],
  ] as const;
  const candidate = (
    await Promise.all(
      candidates.map(async ([path, type]) =>
        (await exists(join(root, path))) ? { path, type } : undefined,
      ),
    )
  ).find(Boolean);
  if (candidate) {
    ecosystem = candidate.type;
    manifest = await readJson(await containedPath(root, candidate.path));
    if (ecosystem === "portable" && manifest.$schema !== PLUGIN_SCHEMA)
      throw new Error("Unsupported portable plugin schema; expected Agent Plugins 1.0.0");
    if (ecosystem === "portable") portableManifest(manifest);
  } else if (await exists(join(root, "SKILL.md"))) {
    manifest = {
      name: (await readSkillMetadata(await containedPath(root, "SKILL.md"))).name,
      version: "0.0.0",
    };
  } else if (await exists(join(root, "skills"))) {
    manifest = { name: options.nameHint ?? basename(root), version: "0.0.0" };
  } else throw new Error("No supported plugin manifest or skills found");
  return { manifest, ecosystem };
}

async function reportUnsupportedFeatures(
  plugin: Plugin,
  manifest: Record<string, unknown>,
): Promise<void> {
  const { root, ecosystem } = plugin;
  if (ecosystem === "portable") {
    for (const key of Object.keys(manifest))
      if (!portableKeys.has(key))
        plugin.unsupported.push(`Portable manifest field ${key} is unsupported and ignored`);
    if (manifest.extensions !== undefined) {
      if (
        !manifest.extensions ||
        typeof manifest.extensions !== "object" ||
        Array.isArray(manifest.extensions)
      )
        plugin.unsupported.push("Invalid extensions field is ignored");
      else
        for (const key of Object.keys(manifest.extensions))
          plugin.unsupported.push(`Client-specific extension ${key} is unsupported`);
    }
  } else {
    const unsupported = [
      "commands",
      "agents",
      "hooks",
      "lspServers",
      "outputStyles",
      "apps",
      "experimental",
      "settings",
      "excludeTools",
      "contextFileName",
      "plan",
      "themes",
      "policies",
      "userConfig",
    ];
    for (const key of unsupported)
      if (manifest[key] !== undefined)
        plugin.unsupported.push(`${ecosystem} ${key} is unsupported`);
  }
  for (const component of [
    "commands",
    "agents",
    "hooks",
    "themes",
    "policies",
    ".app.json",
    ".lsp.json",
    "GEMINI.md",
  ]) {
    if (
      (await exists(join(root, component))) &&
      !plugin.unsupported.some((item) => item.includes(component))
    )
      plugin.unsupported.push(`${ecosystem} component ${component} is unsupported`);
  }
}

async function readServerConfigs(
  plugin: Plugin,
  manifest: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { root, ecosystem } = plugin;
  const configs: Record<string, unknown> = {};
  const paths = ecosystem === "portable" ? ["mcp.json"] : [".mcp.json"];
  if (
    ecosystem !== "portable" &&
    (typeof manifest.mcpServers === "string" || Array.isArray(manifest.mcpServers))
  )
    paths.push(...strings(manifest.mcpServers, "mcpServers"));
  for (const path of [...new Set(paths)]) {
    if (!(await exists(join(root, path)))) continue;
    try {
      const config = await readJson(await containedPath(root, path));
      if (ecosystem === "portable" && config.$schema !== MCP_SCHEMA)
        throw new Error("Unsupported portable MCP schema; expected Agent Plugins 1.0.0");
      if (
        ecosystem === "portable" &&
        Object.keys(config).some((key) => !["$schema", "mcpServers"].includes(key))
      )
        throw new Error("Unknown portable MCP configuration field");
      Object.assign(configs, object(config.mcpServers, "mcpServers"));
    } catch (error) {
      plugin.unsupported.push(`MCP config ${path}: ${message(error)}`);
    }
  }
  if (
    ecosystem !== "portable" &&
    manifest.mcpServers &&
    typeof manifest.mcpServers === "object" &&
    !Array.isArray(manifest.mcpServers)
  )
    Object.assign(configs, manifest.mcpServers);
  return configs;
}

/** Reads metadata/configuration only; it never launches a process or runs plugin hooks. */
export async function loadPlugin(
  directory: string,
  options: LoadPluginOptions = {},
): Promise<Plugin> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error("Plugin root must be a directory");
  const { manifest, ecosystem } = await readManifest(root, options);
  const name = validateName(manifest.name, "Plugin name");
  if (manifest.version !== undefined && typeof manifest.version !== "string")
    throw new Error("Plugin version must be a string");
  const plugin: Plugin = {
    name,
    version: String(manifest.version ?? "0.0.0"),
    root,
    source: root,
    ecosystem,
    skills: [],
    servers: [],
    unsupported: [],
  };
  await reportUnsupportedFeatures(plugin, manifest);
  let locations = (await exists(join(root, "SKILL.md"))) ? ["."] : ["skills"];
  if (ecosystem !== "portable" && manifest.skills !== undefined)
    locations = [...locations, ...strings(manifest.skills, "skills")];
  plugin.skills = await discoverSkills(root, locations, name, plugin.unsupported);
  const configs = await readServerConfigs(plugin, manifest);
  for (const [serverName, config] of Object.entries(configs).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    try {
      plugin.servers.push(await normalizeMcpServer(serverName, config, plugin, options));
    } catch (error) {
      plugin.unsupported.push(message(error));
    }
  }
  return plugin;
}
