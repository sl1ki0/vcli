import { join } from "node:path";
import {
  containedPath,
  exists,
  message,
  object,
  readJson,
  relativeSubdir,
  validateName,
} from "./paths.ts";

export interface MarketplaceEntry {
  name: string;
  description?: string;
  source: string;
  revision?: string;
  subdir?: string;
  local: boolean;
  manifest?: Record<string, unknown>;
  strict?: boolean;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "string" || value[key].length === 0)
    throw new Error(`${key} must be a nonempty string`);
  return value[key];
}

function revision(value: Record<string, unknown>, key: string): string | undefined {
  const result = optionalString(value, key);
  if (
    result !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(result) ||
      result.includes("..") ||
      result.includes("//") ||
      result.endsWith(".") ||
      result.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")))
  )
    throw new Error(`Invalid Git ${key}`);
  return result;
}

function commit(value: Record<string, unknown>): string | undefined {
  const sha = optionalString(value, "sha");
  if (sha !== undefined && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha))
    throw new Error("sha must be a full hexadecimal Git commit (40 or 64 characters)");
  return sha;
}

function subdirectory(value: Record<string, unknown>, key: string): string | undefined {
  const path = optionalString(value, key);
  return path === undefined ? undefined : relativeSubdir(path);
}

function gitSource(source: string): boolean {
  if (/[\s\0]/.test(source)) return false;
  const url = source.replace(/^git\+/, "");
  if (/^git@[^:/]+:.+/.test(url)) return true;
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? parsed.pathname.length > 1 : parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function githubSource(repo: string): string {
  const normalized = repo.replace(/\.git$/, "");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("GitHub repository must be owner/repo");
  return `https://github.com/${normalized}.git`;
}

async function readCatalogEntry(
  root: string,
  name: string,
  entry: Record<string, unknown>,
  pluginRoot: unknown,
): Promise<MarketplaceEntry> {
  if (entry.strict !== undefined && typeof entry.strict !== "boolean")
    throw new Error("strict must be a boolean");
  let source: string;
  let local = false;
  let pin = revision(entry, "revision");
  let subdir = subdirectory(entry, "subdir");
  if (typeof entry.source === "string") {
    source = entry.source;
    if (pluginRoot !== undefined && /^[^/\\]+$/.test(source) && source !== ".") {
      if (typeof pluginRoot !== "string" || !pluginRoot)
        throw new Error("metadata.pluginRoot must be a nonempty relative path");
      source = `./${join(relativeSubdir(pluginRoot), relativeSubdir(source))}`;
    }
    local = !gitSource(source);
  } else {
    const origin = object(entry.source, "Source");
    const kind = origin.source ?? origin.type;
    const originRevision = revision(origin, "revision");
    const ref = revision(origin, "ref");
    const sha = commit(origin);
    const path = subdirectory(origin, "path");
    const originSubdir = subdirectory(origin, "subdir");
    if (path !== undefined && (kind === undefined || kind === "directory" || kind === "local")) {
      source = path;
      local = true;
    } else if (kind === "github") {
      source = githubSource(optionalString(origin, "repo") ?? "");
    } else if (kind === "url" || kind === "git-subdir" || kind === "git" || kind === "repository") {
      source = optionalString(origin, "url") ?? "";
      if (kind === "git-subdir") {
        if (path === undefined) throw new Error("git-subdir requires a path");
        if (!gitSource(source)) source = githubSource(source);
      }
    } else throw new Error("unsupported source format");
    pin = sha ?? ref ?? originRevision ?? pin;
    subdir = (!local ? path : undefined) ?? originSubdir ?? subdir;
  }
  if (local) {
    if (source !== "." && !source.startsWith("./"))
      throw new Error("local source must start with ./ or be .");
    relativeSubdir(source);
    await containedPath(root, source);
    if (subdir) await containedPath(root, join(source, subdir));
  } else if (!gitSource(source)) throw new Error("unsupported repository URL");
  const manifest: Record<string, unknown> = {};
  for (const key of [
    "name",
    "version",
    "description",
    "skills",
    "mcpServers",
    "commands",
    "agents",
    "hooks",
    "outputStyles",
    "themes",
    "lspServers",
    "userConfig",
    "channels",
    "settings",
    "dependencies",
  ]) {
    if (entry[key] !== undefined) manifest[key] = entry[key];
  }
  return {
    name,
    description: typeof entry.description === "string" ? entry.description : undefined,
    source,
    local,
    revision: pin,
    subdir,
    manifest,
    strict: entry.strict,
  };
}

/** Normalize documented catalog sources without executing or downloading packages. */
export async function readMarketplaceCatalog(
  root: string,
): Promise<{ plugins: MarketplaceEntry[]; unsupported: string[] }> {
  const paths = [
    ".claude-plugin/marketplace.json",
    ".codex-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "marketplace.json",
  ];
  const path = (
    await Promise.all(
      paths.map(async (path) => ((await exists(join(root, path))) ? path : undefined)),
    )
  ).find(Boolean);
  if (!path) throw new Error("No marketplace catalog found");
  const data = await readJson(await containedPath(root, path));
  if (!Array.isArray(data.plugins)) throw new Error("Marketplace plugins must be an array");
  const pluginRoot =
    data.metadata === undefined
      ? undefined
      : object(data.metadata, "Marketplace metadata").pluginRoot;
  const plugins: MarketplaceEntry[] = [];
  const unsupported: string[] = [];
  const names = new Set<string>();
  const duplicates = new Set<string>();
  for (const [index, value] of data.plugins.entries()) {
    let name: string | undefined;
    try {
      const entry = object(value, "Marketplace entry");
      name = validateName(entry.name, "Marketplace plugin name");
      if (names.has(name)) {
        duplicates.add(name);
        throw new Error(`Duplicate marketplace plugin: ${name}`);
      }
      names.add(name);
      plugins.push(await readCatalogEntry(root, name, entry, pluginRoot));
    } catch (error) {
      unsupported.push(`Marketplace plugin ${name ?? `at index ${index}`}: ${message(error)}`);
    }
  }
  return { plugins: plugins.filter((plugin) => !duplicates.has(plugin.name)), unsupported };
}
