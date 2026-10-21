import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function validateName(name: unknown, label = "Name"): string {
  if (
    typeof name !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(name) ||
    name.includes("--") ||
    name.includes("..")
  ) {
    throw new Error(`${label} must be 1–64 lowercase letters, numbers, or single hyphens/dots`);
  }
  return name;
}

export function validateServerName(name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
  return name;
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function containedPath(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const candidate = resolve(base, path);
  if (!within(base, candidate)) throw new Error(`Path escapes package root: ${path}`);
  const resolved = await realpath(candidate);
  if (!within(base, resolved)) throw new Error(`Symlink escapes package root: ${path}`);
  return resolved;
}

export function relativeSubdir(path = "."): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) {
    throw new Error(`Subdirectory must stay within the repository: ${path}`);
  }
  return path;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Bound untrusted metadata before parsing and refuse FIFOs/devices without blocking. */
export async function readPackageText(
  path: string,
  limit = 1024 * 1024,
  prefixOnly = false,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Package content must be a regular file: ${path}`);
    if (!prefixOnly && info.size > limit)
      throw new Error(`Package content exceeds ${limit} bytes: ${path}`);
    const buffer = Buffer.alloc(limit + (prefixOnly ? 0 : 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error(`Package content exceeds ${limit} bytes: ${path}`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  const text = await readPackageText(path);
  try {
    return object(JSON.parse(text), path);
  } catch {
    // Parser errors may quote credentials embedded in invalid metadata.
    throw new Error(`Invalid package JSON object: ${path}`);
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
