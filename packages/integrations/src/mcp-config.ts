import { isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { NormalizedMcpServer, Plugin } from "@vcli/core";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { containedPath, exists, object, validateServerName, within } from "./paths.ts";
import { mcpSchema } from "./schemas.ts";
import { pluginFormat } from "./formats.ts";
import { validateMcpHttpUrl, validateMcpServer } from "./mcp-validation.ts";

interface ImportOptions {
  dataRoot?: string;
  workspaceRoot?: string;
}
interface ServerContext {
  name: string;
  namespace: string;
  config: Record<string, unknown>;
  plugin: Plugin;
  portable: boolean;
  dataRoot: string;
  expand: (value: string) => string;
}

const schemaValidator = new AjvJsonSchemaValidator();
const validateServer = schemaValidator.getValidator({
  ...mcpSchema,
  $id: `${mcpSchema.$id}.server`,
  $ref: "#/$defs/server",
  properties: undefined,
  required: undefined,
  additionalProperties: undefined,
} as JsonSchemaType);

function stringMap(value: unknown, label: string): Record<string, string> {
  const map = object(value, label);
  if (!Object.values(map).every((item) => typeof item === "string"))
    throw new Error(`${label} must contain string values`);
  return map as Record<string, string>;
}

function configExpansion(
  name: string,
  plugin: Plugin,
  dataRoot: string,
  options: ImportOptions,
): (value: string) => string {
  const portable = plugin.ecosystem === "portable";
  const replacements: Record<string, string> = { PLUGIN_ROOT: plugin.root, PLUGIN_DATA: dataRoot };
  if (!portable)
    Object.assign(replacements, {
      CLAUDE_PLUGIN_ROOT: plugin.root,
      CODEX_PLUGIN_ROOT: plugin.root,
      extensionPath: plugin.root,
      workspacePath: options.workspaceRoot ?? process.cwd(),
      "/": sep,
      pathSeparator: sep,
    });
  return (value) =>
    value.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
      // One pass: replacement values may themselves contain literal ${...} text.
      if (Object.hasOwn(replacements, expression)) return replacements[expression]!;
      const variable = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/.exec(expression);
      if (!variable) throw new Error(`MCP server ${name}: unsupported variable substitution`);
      const [, key, fallback] = variable;
      // Package metadata is untrusted. Expanding ambient values would let a
      // manifest copy provider credentials into HTTP destinations or subprocesses.
      if (!portable && fallback !== undefined) return fallback;
      throw new Error(
        `MCP server ${name}: ambient environment variable ${key} is unsupported; configure an explicit literal value`,
      );
    });
}

function validateTransport(context: ServerContext): void {
  const { name, config, plugin, portable } = context;
  const declaredType = config.type;
  for (const key of ["type", "command", "url", "httpUrl", "cwd"])
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]))
      throw new Error(`MCP server ${name}: ${key} must be a nonempty string`);
  if (config.url !== undefined && config.httpUrl !== undefined)
    throw new Error(`MCP server ${name}: declare only one of url and httpUrl`);
  if ((config.url !== undefined || config.httpUrl !== undefined) && config.command !== undefined)
    throw new Error(`MCP server ${name}: command conflicts with HTTP transport`);
  if (!portable) {
    if (config.includeTools !== undefined || config.excludeTools !== undefined)
      throw new Error(
        `MCP server ${name}: vendor tool filters are unsupported; server disabled to preserve the declared restrictions`,
      );
    if (config.trust !== undefined)
      plugin.unsupported.push(
        `MCP ${name}: vendor trust flag is ignored; vcli permissions still apply`,
      );
    if (config.timeout !== undefined)
      plugin.unsupported.push(
        `MCP ${name}: vendor timeout is ignored; use vcli MCP timeout settings`,
      );
  } else {
    const validation = validateServer(config);
    if (!validation.valid)
      throw new Error(
        `MCP server ${name}: invalid portable configuration: ${validation.errorMessage}`,
      );
    const allowed = new Set(
      declaredType === "stdio"
        ? ["type", "command", "args", "env", "cwd"]
        : ["type", "url", "headers"],
    );
    const unknown = Object.keys(config).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new Error(`MCP server ${name}: unsupported portable fields ${unknown.join(", ")}`);
    if (!["stdio", "streamable-http"].includes(String(declaredType)))
      throw new Error(`MCP server ${name}: portable type must be stdio or streamable-http`);
  }
  if (declaredType === "sse")
    throw new Error(`MCP server ${name}: legacy SSE transport is unsupported; use Streamable HTTP`);
  const legacyUrl =
    pluginFormat(plugin.ecosystem).legacyUrl &&
    typeof config.url === "string" &&
    config.httpUrl === undefined &&
    declaredType !== "http" &&
    declaredType !== "streamable-http";
  if (legacyUrl)
    throw new Error(
      `MCP server ${name}: ${plugin.ecosystem} url uses legacy SSE; use httpUrl for Streamable HTTP`,
    );
}

function normalizeHttpServer(context: ServerContext): NormalizedMcpServer {
  const { name, namespace, config, plugin, expand } = context;
  if (config.type && !["http", "streamable-http"].includes(String(config.type)))
    throw new Error(`MCP server ${name}: URL conflicts with transport type`);
  for (const key of ["args", "env", "cwd"])
    if (config[key] !== undefined)
      throw new Error(`MCP server ${name}: ${key} is unsupported for HTTP transport`);
  const configuredUrl = (config.httpUrl ?? config.url) as string;
  const url = validateMcpHttpUrl(expand(configuredUrl));

  const headers =
    config.headers !== undefined
      ? Object.fromEntries(
          Object.entries(stringMap(config.headers, `MCP ${name} headers`)).map(([key, value]) => [
            key,
            expand(value),
          ]),
        )
      : undefined;
  if (headers) {
    if (Object.entries(headers).some(([key, value]) => /[\r\n]/.test(key + value)))
      throw new Error(`MCP server ${name}: invalid header`);
    const names = Object.keys(headers).map((key) => key.toLowerCase());
    if (names.length !== new Set(names).size)
      throw new Error(`MCP server ${name}: duplicate header names`);
  }
  if (config.oauth !== undefined || config.auth !== undefined)
    plugin.unsupported.push(
      `MCP ${name}: automatic OAuth setup is unsupported; configure credentials explicitly`,
    );
  const server: NormalizedMcpServer = { name: namespace, type: "http", url: url.href, headers };
  validateMcpServer(server);
  return server;
}

async function workingDirectory(context: ServerContext): Promise<string> {
  const { name, config, plugin, portable, dataRoot, expand } = context;
  const configured = typeof config.cwd === "string" ? expand(config.cwd) : plugin.root;
  let cwd = isAbsolute(configured) ? resolve(configured) : resolve(plugin.root, configured);
  if (portable && !within(plugin.root, cwd) && !within(dataRoot, cwd))
    throw new Error(`MCP server ${name}: cwd escapes package/data root`);
  if (await exists(cwd)) {
    cwd = await realpath(cwd);
    if (portable && !within(plugin.root, cwd) && !within(dataRoot, cwd))
      throw new Error(`MCP server ${name}: cwd symlink escapes package/data root`);
  }
  return cwd;
}

async function normalizeStdioServer(context: ServerContext): Promise<NormalizedMcpServer> {
  const { name, namespace, config, plugin, portable, dataRoot, expand } = context;
  if (config.type && config.type !== "stdio")
    throw new Error(`MCP server ${name}: missing HTTP URL`);
  if (typeof config.command !== "string" || !config.command || /[\r\n\0]/.test(config.command))
    throw new Error(`MCP server ${name}: command must be one executable`);
  const command = expand(config.command);
  if (portable && !(config.command.startsWith("./") || !/[\\/\s]/.test(config.command)))
    throw new Error(
      `MCP server ${name}: portable command must be a bare executable or ./package-path`,
    );
  if (!isAbsolute(command) && !command.startsWith("./") && /\s/.test(command))
    throw new Error(`MCP server ${name}: command cannot contain shell arguments`);
  const resolvedCommand =
    !isAbsolute(command) && /[\\/]/.test(command)
      ? await containedPath(plugin.root, command)
      : command;
  if (
    isAbsolute(resolvedCommand) &&
    (portable || config.command.includes("PLUGIN_ROOT") || config.command.includes("extensionPath"))
  )
    await containedPath(plugin.root, resolvedCommand);

  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) || !config.args.every((item) => typeof item === "string"))
  )
    throw new Error(`MCP server ${name}: args must be an array of strings`);
  const args = (config.args as string[] | undefined)?.map(expand) ?? [];
  const env =
    config.env === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(stringMap(config.env, `MCP ${name} env`)).map(([key, value]) => [
            key,
            expand(value),
          ]),
        );
  if (portable && ("PLUGIN_ROOT" in env || "PLUGIN_DATA" in env))
    throw new Error(`MCP server ${name}: PLUGIN_ROOT and PLUGIN_DATA are reserved`);
  if (
    [resolvedCommand, ...args, ...Object.values(env)].some((value) =>
      /\$\{user_config\./.test(value),
    )
  )
    throw new Error(`MCP server ${name}: interactive user_config substitution is unsupported`);
  return {
    name: namespace,
    type: "stdio",
    command: resolvedCommand,
    args,
    cwd: await workingDirectory(context),
    env: { ...env, PLUGIN_ROOT: plugin.root, PLUGIN_DATA: dataRoot },
  };
}

export async function normalizeMcpServer(
  name: string,
  raw: unknown,
  plugin: Plugin,
  options: ImportOptions,
): Promise<NormalizedMcpServer> {
  validateServerName(name);
  const config = object(raw, `MCP server ${name}`);
  const dataPath = resolve(options.dataRoot ?? join(plugin.root, ".vcli-data"));
  const dataRoot = (await exists(dataPath)) ? await realpath(dataPath) : dataPath;
  const context: ServerContext = {
    name,
    namespace: `${plugin.name}.${name}`,
    config,
    plugin,
    portable: plugin.ecosystem === "portable",
    dataRoot,
    expand: configExpansion(name, plugin, dataRoot, options),
  };
  validateTransport(context);
  if (typeof config.url === "string" || typeof config.httpUrl === "string")
    return normalizeHttpServer(context);
  return normalizeStdioServer(context);
}
