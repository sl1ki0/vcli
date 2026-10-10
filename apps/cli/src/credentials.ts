import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configHome, writeJsonAtomic, type Config } from "./config.ts";

export type CredentialTarget = Pick<Config, "provider" | "baseURL">;
export type CredentialStatus = "environment" | "saved" | "session" | "missing" | "not-required";
export interface ResolvedCredential {
  apiKey?: string;
  status: CredentialStatus;
}
interface CredentialFile {
  version: 1;
  keys: Record<string, string>;
}

const variables: Record<Config["provider"], string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  compatible: ["VCLI_COMPATIBLE_API_KEY"],
};

export function normalizeEndpoint(value?: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("The endpoint must be a URL");
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid URL");
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new Error("The endpoint must be an HTTP(S) URL without credentials, query, or fragment");
  }
}

/** Credentials are scoped to both provider and endpoint, including custom hosted providers. */
export function credentialScope(target: CredentialTarget): string {
  return `${target.provider}:${normalizeEndpoint(target.baseURL) ?? "default"}`;
}

export function validateApiKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value))
    throw new Error("The API key must be a nonempty single line");
  return value.trim();
}

async function readCredentials(): Promise<CredentialFile> {
  try {
    const file: unknown = JSON.parse(
      await readFile(join(configHome(), "credentials.json"), "utf8"),
    );
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Invalid store");
    const { version, keys } = file as CredentialFile;
    if (
      version !== 1 ||
      !keys ||
      typeof keys !== "object" ||
      Array.isArray(keys) ||
      Object.values(keys).some((key) => typeof key !== "string" || !key)
    )
      throw new Error("Invalid store");
    for (const key of Object.values(keys)) validateApiKey(key);
    return { version, keys };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: {} };
    throw new Error("Could not read the saved credential store");
  }
}

export async function saveCredential(target: CredentialTarget, apiKey: string): Promise<void> {
  const key = validateApiKey(apiKey);
  const scope = credentialScope(target);
  const state = await readCredentials();
  state.keys[scope] = key;
  try {
    await mkdir(configHome(), { recursive: true, mode: 0o700 });
    await chmod(configHome(), 0o700);
    await writeJsonAtomic(join(configHome(), "credentials.json"), state);
  } catch {
    throw new Error("Could not save the API key");
  }
}

/** Explicit runtime keys override environment keys; saved keys are the final authenticated fallback. */
export async function resolveCredential(
  target: CredentialTarget,
  override?: string,
): Promise<ResolvedCredential> {
  if (override) return { apiKey: validateApiKey(override), status: "session" };
  for (const name of variables[target.provider]) {
    const value = process.env[name];
    if (value?.trim()) return { apiKey: validateApiKey(value), status: "environment" };
  }
  const saved = (await readCredentials()).keys[credentialScope(target)];
  if (saved) return { apiKey: saved, status: "saved" };
  if (target.provider === "compatible" && target.baseURL) return { status: "not-required" };
  return { status: "missing" };
}
