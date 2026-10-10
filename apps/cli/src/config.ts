import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  balanced,
  type ContextSettings,
  type PermissionMode,
  type NormalizedMcpServer,
} from "@vcli/core";

export interface Config {
  provider: "openai" | "anthropic" | "gemini" | "compatible";
  model: string;
  permission: PermissionMode;
  renderer: "auto" | "kitty" | "sixel" | "blocks" | "off";
  baseURL?: string;
  contextWindow?: number;
  context: ContextSettings;
  mcpServers: NormalizedMcpServer[];
}
export const configHome = (): string =>
  process.env.VCLI_CONFIG_HOME ?? join(homedir(), ".config", "vcli");
const defaults: Config = {
  provider: "openai",
  model: "",
  permission: "yolo",
  renderer: "auto",
  context: balanced,
  mcpServers: [],
};
async function readJson(path: string): Promise<Partial<Config>> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Expected an object");
    return data as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Invalid config ${path}: ${String(error)}`);
  }
}
export function validateConfig(config: Config): Config {
  if (!["openai", "anthropic", "gemini", "compatible"].includes(config.provider))
    throw new Error("Unknown provider");
  if (!["yolo", "ask", "read-only"].includes(config.permission))
    throw new Error("permission must be yolo, ask, or read-only");
  if (!["auto", "kitty", "sixel", "blocks", "off"].includes(config.renderer))
    throw new Error("Unknown renderer");
  if (typeof config.model !== "string") throw new Error("model must be a string");
  for (const [key, value] of Object.entries(config.context))
    if (!Number.isSafeInteger(value) || Number(value) <= 0)
      throw new Error(`context.${key} must be a positive integer`);
  if (
    config.contextWindow !== undefined &&
    (!Number.isSafeInteger(config.contextWindow) || config.contextWindow < 1024)
  )
    throw new Error("contextWindow must be >=1024");
  if (config.baseURL && !/^https?:\/\//.test(config.baseURL))
    throw new Error("baseURL must be HTTP(S)");
  if (!Array.isArray(config.mcpServers)) throw new Error("mcpServers must be an array");
  return config;
}
export async function loadConfig(root: string, overrides: Partial<Config> = {}): Promise<Config> {
  const user = await readJson(join(configHome(), "config.json"));
  const project = await readJson(join(root, ".vcli", "config.json"));
  return validateConfig({
    ...defaults,
    ...user,
    ...project,
    ...overrides,
    context: { ...balanced, ...user.context, ...project.context, ...overrides.context },
  });
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
    "mcpServers",
    ...Object.keys(balanced).map((k) => "context." + k),
    "context.taskTokens",
  ];
  if (!allowed.includes(key))
    throw new Error(`Unknown setting ${key}. API credentials belong in environment variables.`);
  const path = project ? join(root, ".vcli", "config.json") : join(configHome(), "config.json");
  const current = await readJson(path);
  if (key.startsWith("context."))
    current.context = { ...current.context, [key.slice(8)]: value } as ContextSettings;
  else (current as Record<string, unknown>)[key] = value;
  validateConfig({ ...defaults, ...current, context: { ...balanced, ...current.context } });
  await mkdir(project ? join(root, ".vcli") : configHome(), { recursive: true });
  await writeFile(path, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
}
