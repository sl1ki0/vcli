import { basename, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Plugin, PluginEcosystem } from "@vcli/core";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { containedPath, exists, message, object, readJson, validateName } from "./paths.ts";
import { discoverSkills, readSkillMetadata } from "./skills.ts";
import { normalizeMcpServer } from "./mcp-config.ts";
import { pluginSchema } from "./schemas.ts";
import { pluginFormat, pluginFormats, vendorComponentFields } from "./formats.ts";

export interface LoadPluginOptions {
  dataRoot?: string;
  workspaceRoot?: string;
  nameHint?: string;
  format?: PluginEcosystem;
  marketplaceManifest?: Record<string, unknown>;
  marketplaceStrict?: boolean;
  requireManifest?: boolean;
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
  const candidates = options.format ? [pluginFormat(options.format)] : pluginFormats;
  const detected = (
    await Promise.all(
      candidates.map(async (format) =>
        (await exists(join(root, format.manifest))) ? format : undefined,
      ),
    )
  ).filter((format) => format !== undefined);
  if (detected.length > 1)
    throw new Error(
      `Multiple plugin manifests found (${detected.map((f) => f.id).join(", ")}); select --format explicitly`,
    );
  const candidate = detected[0];
  if (candidate) {
    ecosystem = candidate.id;
    manifest = await readJson(await containedPath(root, candidate.manifest));
    if (ecosystem === "portable" && manifest.$schema !== PLUGIN_SCHEMA)
      throw new Error("Unsupported portable plugin schema; expected Agent Plugins 1.0.0");
    if (ecosystem === "portable") portableManifest(manifest);
    if (options.marketplaceManifest) {
      const entry = options.marketplaceManifest;
      const components = vendorComponentFields.filter((key) => entry[key] !== undefined);
      if (ecosystem !== "claude" && components.length)
        throw new Error("Marketplace component declarations require a Claude plugin format");
      if (components.length && options.marketplaceStrict === false)
        throw new Error(
          "Conflicting manifests: strict:false entry and plugin both declare components",
        );
      if (entry.skills !== undefined) {
        manifest.skills = [
          ...(manifest.skills === undefined ? [] : strings(manifest.skills, "skills")),
          ...strings(entry.skills, "Marketplace skills"),
        ];
      }
      // Unsupported components stay visible without activating host-specific behavior.
      for (const key of components) if (key !== "skills") manifest[key] ??= entry[key];
    }
  } else if (options.requireManifest) {
    throw new Error("Installed package manifest is missing");
  } else if (options.marketplaceManifest && (!options.format || options.format === "claude")) {
    ecosystem = "claude";
    manifest = { ...options.marketplaceManifest };
  } else if (options.format) {
    throw new Error(`No ${options.format} plugin manifest found`);
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
      "workflows",
      "channels",
      "dependencies",
      "migratedTo",
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
    ...(pluginFormat(ecosystem).contextFile ? [pluginFormat(ecosystem).contextFile!] : []),
    "workflows",
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
  const paths = [pluginFormat(ecosystem).mcpFile];
  if (ecosystem !== "portable" && manifest.mcpServers !== undefined) {
    try {
      if (typeof manifest.mcpServers === "string" || Array.isArray(manifest.mcpServers))
        paths.push(...strings(manifest.mcpServers, "mcpServers"));
      else object(manifest.mcpServers, "mcpServers");
    } catch (error) {
      plugin.unsupported.push(`MCP declaration: ${message(error)}`);
    }
  }
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
    version: manifest.version ?? "0.0.0",
    root,
    source: root,
    ecosystem,
    skills: [],
    servers: [],
    unsupported: [],
  };
  await reportUnsupportedFeatures(plugin, manifest);
  if (options.marketplaceManifest && (await exists(join(root, pluginFormat(ecosystem).manifest)))) {
    for (const key of Object.keys(options.marketplaceManifest)) {
      if (["name", "version", "description", ...vendorComponentFields].includes(key)) continue;
      plugin.unsupported.push(
        `Marketplace ${key} ignored because the package manifest is authoritative`,
      );
    }
  }
  let locations = (await exists(join(root, "SKILL.md"))) ? ["."] : ["skills"];
  if (ecosystem !== "portable" && manifest.skills !== undefined) {
    try {
      locations = [...locations, ...strings(manifest.skills, "skills")];
    } catch (error) {
      plugin.unsupported.push(`Skill declaration: ${message(error)}`);
    }
  }
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
