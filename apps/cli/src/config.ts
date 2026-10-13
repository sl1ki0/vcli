import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  balanced,
  type ContextSettings,
  type PermissionMode,
  type NormalizedMcpServer,
  type ReasoningEffort,
} from "@vcli/core";
import { REASONING_EFFORTS } from "@vcli/providers";

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
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
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
  if (!["openai", "anthropic", "gemini", "openrouter", "compatible"].includes(config.provider))
    throw new Error("Unknown provider");
  if (config.reasoning !== undefined && !REASONING_EFFORTS.includes(config.reasoning))
    throw new Error("Unknown reasoning effort");
  if (!["yolo", "ask", "read-only"].includes(config.permission))
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
  // Unknown file fields are retained on disk, never included in runtime/settings snapshots.
  return {
    provider: config.provider,
    model: config.model,
    permission: config.permission,
    renderer: config.renderer,
    baseURL: config.baseURL,
    contextWindow: config.contextWindow,
    reasoning: config.reasoning ?? "default",
    context: { ...config.context },
    mcpServers: config.mcpServers,
  };
}
function mergeConfig(...layers: ConfigFile[]): Config {
  let merged: ConfigFile = { ...defaults, context: { ...balanced } };
  for (const layer of layers) {
    if (
      layer.context !== undefined &&
      (!layer.context || typeof layer.context !== "object" || Array.isArray(layer.context))
    )
      throw new Error("context must be an object");
    merged = { ...merged, ...layer, context: { ...merged.context, ...layer.context } };
  }
  if (merged.baseURL === null) merged.baseURL = undefined;
  if (merged.context?.taskTokens === null) merged.context.taskTokens = undefined;
  return validateConfig(merged as Config);
}
export async function loadConfig(root: string, overrides: Partial<Config> = {}): Promise<Config> {
  const [user, project] = await Promise.all([
    readJson(join(configHome(), "config.json")),
    readJson(join(root, ".vcli", "config.json")),
  ]);
  return mergeConfig(user, project, overrides);
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
  const allowed = new Set(Object.keys(defaults).concat("baseURL", "contextWindow"));
  if (Object.keys(patch).some((key) => !allowed.has(key)))
    throw new Error("Unknown setting; use vcli setup or environment variables for API credentials");
  if (
    patch.context !== undefined &&
    (!patch.context || typeof patch.context !== "object" || Array.isArray(patch.context))
  )
    throw new Error("context must be an object");
  const [user, local] = await Promise.all([
    readJson(join(configHome(), "config.json")),
    readJson(join(root, ".vcli", "config.json")),
  ]);
  const current = project ? local : user;
  const next: ConfigFile = { ...current, ...patch };
  if (patch.context !== undefined) next.context = { ...current.context, ...patch.context };
  const effective = project ? mergeConfig(user, next) : mergeConfig(next, local);
  if (!project) mergeConfig(next);
  await writeJsonAtomic(
    project ? join(root, ".vcli", "config.json") : join(configHome(), "config.json"),
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
    ...Object.keys(balanced).map((k) => "context." + k),
    "context.taskTokens",
  ];
  if (!allowed.includes(key))
    throw new Error(
      `Unknown setting ${key}. Use vcli setup or environment variables for API credentials.`,
    );
  const patch = key.startsWith("context.")
    ? { context: { [key.slice(8)]: value } }
    : { [key]: value };
  await patchConfig(root, patch as ConfigPatch, project);
}
