import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  balanced,
  type ContextSettings,
  type PermissionMode,
  type NormalizedMcpServer,
  type ReasoningEffort,
  type RunLimits,
} from "@vcli/core";
import { REASONING_EFFORTS } from "@vcli/providers";
import { readStorageText, storagePath } from "./workflows/state-path.ts";

export interface Config {
  provider: "openai" | "anthropic" | "gemini" | "openrouter" | "compatible";
  model: string;
  permission: PermissionMode;
  renderer: "auto" | "kitty" | "sixel" | "blocks" | "off";
  baseURL?: string;
  contextWindow?: number;
  reasoning?: ReasoningEffort;
  context: ContextSettings;
  mcpServers: NormalizedMcpServer[];
  runLimits?: Partial<RunLimits>;
}
export type ConfigPatch = Partial<Omit<Config, "context" | "baseURL">> & {
  context?: Partial<Omit<ContextSettings, "taskTokens">> & { taskTokens?: number | null };
  /** null explicitly clears an endpoint inherited from user configuration. */
  baseURL?: string | null;
};
type ConfigFile = ConfigPatch & Record<string, unknown>;
export const configHome = (): string =>
  process.env.VCLI_CONFIG_HOME ?? join(homedir(), ".config", "vcli");
const defaults: Config = {
  provider: "openai",
  model: "",
  permission: "yolo",
  renderer: "auto",
  reasoning: "default",
  context: balanced,
  mcpServers: [],
};
async function readJson(path: string): Promise<ConfigFile> {
  try {
    const data: unknown = JSON.parse(await readStorageText(path, 1024 * 1024));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Expected an object");
    return data as ConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // JSON parser diagnostics can include snippets of the original file.
    throw new Error(`Invalid config ${path}: expected a JSON object`);
  }
}
export function validateConfig(config: Config): Config {
  const permission =
    ({ safe: "ask", auto: "yolo" } as Record<string, PermissionMode>)[config.permission] ??
    config.permission;
  if (!["openai", "anthropic", "gemini", "openrouter", "compatible"].includes(config.provider))
    throw new Error("Unknown provider");
  if (config.reasoning !== undefined && !REASONING_EFFORTS.includes(config.reasoning))
    throw new Error("Unknown reasoning effort");
  if (!["yolo", "ask", "read-only"].includes(permission))
    throw new Error("permission must be yolo, ask, or read-only");
  if (!["auto", "kitty", "sixel", "blocks", "off"].includes(config.renderer))
    throw new Error("Unknown renderer");
  if (typeof config.model !== "string") throw new Error("model must be a string");
  if (!config.context || typeof config.context !== "object" || Array.isArray(config.context))
    throw new Error("context must be an object");
  for (const key of Object.keys(balanced)) {
    if (!Object.hasOwn(config.context, key)) throw new Error(`context.${key} is required`);
  }
  for (const [key, value] of Object.entries(config.context))
    if (key === "taskTokens" && value === undefined) continue;
    else if (!Number.isSafeInteger(value) || Number(value) <= 0)
      throw new Error(`context.${key} must be a positive integer`);
  if (
    config.contextWindow !== undefined &&
    (!Number.isSafeInteger(config.contextWindow) || config.contextWindow < 1024)
  )
    throw new Error("contextWindow must be >=1024");
  if (config.baseURL !== undefined) {
    try {
      const url = new URL(config.baseURL);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid endpoint");
    } catch {
      throw new Error(
        "baseURL must be an HTTP(S) endpoint without credentials, query, or fragment",
      );
    }
  }
  if (!Array.isArray(config.mcpServers)) throw new Error("mcpServers must be an array");
  if (config.runLimits !== undefined) {
    if (
      !config.runLimits ||
      typeof config.runLimits !== "object" ||
      Array.isArray(config.runLimits)
    )
      throw new Error("runLimits must be an object");
    const names = ["modelRequests", "toolCalls", "sideEffects", "resultBytes"];
    for (const [key, value] of Object.entries(config.runLimits))
      if (!names.includes(key) || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`runLimits.${key} must be a nonnegative safe integer`);
  }
  // Unknown file fields are retained on disk, never included in runtime/settings snapshots.
  return {
    provider: config.provider,
    model: config.model,
    permission,
    renderer: config.renderer,
    baseURL: config.baseURL,
    contextWindow: config.contextWindow,
    reasoning: config.reasoning ?? "default",
    context: { ...config.context },
    mcpServers: config.mcpServers,
    ...(config.runLimits ? { runLimits: { ...config.runLimits } } : {}),
  };
}
function mergeConfig(...layers: ConfigFile[]): Config {
  let merged: ConfigFile = { ...defaults, context: { ...balanced } };
  for (const layer of layers) {
    if (
      layer.runLimits !== undefined &&
      (!layer.runLimits || typeof layer.runLimits !== "object" || Array.isArray(layer.runLimits))
    )
      throw new Error("runLimits must be an object");
    if (
      layer.context !== undefined &&
      (!layer.context || typeof layer.context !== "object" || Array.isArray(layer.context))
    )
      throw new Error("context must be an object");
    merged = {
      ...merged,
      ...layer,
      context: { ...merged.context, ...layer.context },
      ...(merged.runLimits || layer.runLimits
        ? { runLimits: { ...merged.runLimits, ...layer.runLimits } }
        : {}),
    };
  }
  if (merged.baseURL === null) merged.baseURL = undefined;
  if (merged.context?.taskTokens === null) merged.context.taskTokens = undefined;
  return validateConfig(merged as Config);
}
const permissionStrength: Record<PermissionMode, number> = { yolo: 0, ask: 1, "read-only": 2 };
function mergeScopedConfig(
  user: ConfigFile,
  project: ConfigFile,
  overrides: ConfigFile = {},
): Config {
  const personal = mergeConfig(user);
  const local = mergeConfig(user, project);
  // A checkout can restrict the user's policy; only explicit runtime options may relax it.
  if (permissionStrength[local.permission] < permissionStrength[personal.permission])
    local.permission = personal.permission;
  if (personal.context.taskTokens !== undefined)
    local.context.taskTokens = Math.min(
      local.context.taskTokens ?? personal.context.taskTokens,
      personal.context.taskTokens,
    );
  for (const [name, ceiling] of Object.entries(personal.runLimits ?? {})) {
    const key = name as keyof RunLimits;
    local.runLimits ??= {};
    local.runLimits[key] = Math.min(local.runLimits[key] ?? ceiling, ceiling);
  }
  return mergeConfig({ ...local }, overrides);
}
export async function loadConfig(root: string, overrides: Partial<Config> = {}): Promise<Config> {
  const [user, project] = await Promise.all([
    readJson(join(configHome(), "config.json")),
    storagePath(root, ["config.json"]).then(readJson),
  ]);
  return mergeScopedConfig(user, project, overrides);
}
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Applies and validates a batch before the single atomic configuration write. */
export async function patchConfig(
  root: string,
  patch: ConfigPatch,
  project = true,
): Promise<Config> {
  const allowed = new Set(Object.keys(defaults).concat("baseURL", "contextWindow", "runLimits"));
  if (Object.keys(patch).some((key) => !allowed.has(key)))
    throw new Error("Unknown setting; use vcli setup or environment variables for API credentials");
  if (
    patch.context !== undefined &&
    (!patch.context || typeof patch.context !== "object" || Array.isArray(patch.context))
  )
    throw new Error("context must be an object");
  const [user, local] = await Promise.all([
    readJson(join(configHome(), "config.json")),
    storagePath(root, ["config.json"]).then(readJson),
  ]);
  const current = project ? local : user;
  if (project && patch.permission !== undefined) {
    const ceiling = mergeConfig(user).permission;
    const requested = mergeConfig({ permission: patch.permission }).permission;
    if (permissionStrength[requested] < permissionStrength[ceiling])
      throw new Error(
        `Project permission cannot weaken the user permission ${ceiling}. Change the user setting or use an explicit --permission override.`,
      );
  }
  const next: ConfigFile = { ...current, ...patch };
  if (patch.context !== undefined) next.context = { ...current.context, ...patch.context };
  if (patch.runLimits !== undefined) {
    if (!patch.runLimits || typeof patch.runLimits !== "object" || Array.isArray(patch.runLimits))
      throw new Error("runLimits must be an object");
    next.runLimits = { ...current.runLimits, ...patch.runLimits };
  }
  if (project) {
    const personal = mergeConfig(user);
    const taskCeiling = personal.context.taskTokens;
    if (
      taskCeiling !== undefined &&
      patch.context &&
      Object.hasOwn(patch.context, "taskTokens") &&
      (patch.context.taskTokens === null ||
        patch.context.taskTokens === undefined ||
        patch.context.taskTokens > taskCeiling)
    )
      throw new Error(
        `Project context.taskTokens cannot weaken the user token limit ${taskCeiling}. Update or clear the user setting first.`,
      );
    for (const [name, value] of Object.entries(patch.runLimits ?? {})) {
      const ceiling = personal.runLimits?.[name as keyof RunLimits];
      if (ceiling !== undefined && value > ceiling)
        throw new Error(
          `Project runLimits.${name} cannot exceed the user limit ${ceiling}. Update the user setting first.`,
        );
    }
  }
  const effective = project ? mergeScopedConfig(user, next) : mergeScopedConfig(next, local);
  if (!project) mergeConfig(next);
  await writeJsonAtomic(
    project ? await storagePath(root, ["config.json"]) : join(configHome(), "config.json"),
    next,
  );
  return effective;
}
export async function setConfig(
  root: string,
  key: string,
  value: unknown,
  project = false,
): Promise<void> {
  const allowed = [
    "provider",
    "model",
    "permission",
    "renderer",
    "baseURL",
    "contextWindow",
    "reasoning",
    "mcpServers",
    "runLimits",
    "runLimits.modelRequests",
    "runLimits.toolCalls",
    "runLimits.sideEffects",
    "runLimits.resultBytes",
    ...Object.keys(balanced).map((k) => "context." + k),
    "context.taskTokens",
  ];
  if (!allowed.includes(key))
    throw new Error(
      `Unknown setting ${key}. Use vcli setup or environment variables for API credentials.`,
    );
  const patch = key.startsWith("context.")
    ? { context: { [key.slice(8)]: value } }
    : key.startsWith("runLimits.")
      ? { runLimits: { [key.slice(10)]: value } }
      : { [key]: value };
  await patchConfig(root, patch as ConfigPatch, project);
}
