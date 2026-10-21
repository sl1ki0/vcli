import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { compare, matchesPath, slash } from "./utils.ts";
import { readArchitectureFile } from "./state-path.ts";
import type { ArchitectureScanScope } from "@vcli/core";
import { ArchitectureScanLimitError } from "./scan-limits.ts";

const ALWAYS_IGNORED = new Set([
  ".git",
  "node_modules",
  ".vcli",
  "dist",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);
export const JS_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const SOURCE =
  /\.(?:[cm]?[jt]s|[jt]sx|py|rs|go|java|kt|kts|cs|c|cc|cpp|h|hpp|rb|php|swift|sh|bash|zsh|vue|svelte)$/i;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_INVENTORY_ENTRIES = 100_000;
export const MAX_INVENTORY_FILES = 20_000;
export const MAX_DIRECTORY_DEPTH = 128;
interface IgnoreRule {
  base: string;
  pattern: string;
  negate: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function inventory(
  root: string,
  diagnostics: string[],
  scope?: ArchitectureScanScope,
): Promise<string[]> {
  const files: string[] = [];
  let entriesSeen = 0;
  let ignoreBytes = 0;
  let ignoreRules = 0;
  async function walk(directory: string, inherited: IgnoreRule[], depth = 0) {
    if (scope && !(await scope.allowDirectory(directory))) return;
    if (depth > MAX_DIRECTORY_DEPTH)
      throw new ArchitectureScanLimitError("Architecture scan directory depth exceeds 128.");
    let rules = inherited;
    try {
      const ignorePath = join(directory, ".gitignore");
      const text =
        !scope || (await scope.allowFile(ignorePath))
          ? await readArchitectureFile(ignorePath, 65_536)
          : "";
      ignoreBytes += Buffer.byteLength(text);
      if (ignoreBytes > 4 * 1024 * 1024)
        throw new ArchitectureScanLimitError("Architecture scan ignore input exceeds 4 MiB.");
      const base = slash(relative(root, directory));
      rules = [
        ...rules,
        ...text
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => ({
            base,
            pattern: line.replace(/^!/, "").replace(/^\//, "").replace(/\/$/, ""),
            negate: line.startsWith("!"),
          })),
      ];
      ignoreRules += rules.length - inherited.length;
      if (ignoreRules > 1000)
        throw new ArchitectureScanLimitError("Architecture scan ignore rules exceed 1,000.");
    } catch (error) {
      if (error instanceof ArchitectureScanLimitError) throw error;
      if (!isMissing(error))
        diagnostics.push(
          `Could not read ${slash(relative(root, directory)) || "."}/.gitignore: ${(error as Error).message}`,
        );
    }
    for await (const entry of await opendir(directory)) {
      if (++entriesSeen > MAX_INVENTORY_ENTRIES)
        throw new ArchitectureScanLimitError(
          "Architecture scan inventory exceeds 100,000 entries.",
        );
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ALWAYS_IGNORED.has(entry.name)) continue;
      const absolute = join(directory, entry.name),
        path = slash(relative(root, absolute));
      let ignored = false;
      for (const rule of rules) {
        const local = rule.base
          ? path.startsWith(`${rule.base}/`)
            ? path.slice(rule.base.length + 1)
            : undefined
          : path;
        if (local === undefined) continue;
        const matched = rule.pattern.includes("/")
          ? matchesPath(local, rule.pattern)
          : local.split("/").some((part) => matchesPath(part, rule.pattern));
        if (matched) ignored = !rule.negate;
      }
      if (ignored) continue;
      if (entry.isDirectory()) await walk(absolute, rules, depth + 1);
      else if (entry.isFile() && (!scope || (await scope.allowFile(absolute)))) files.push(path);
      if (files.length > MAX_INVENTORY_FILES)
        throw new ArchitectureScanLimitError("Architecture scan inventory exceeds 20,000 files.");
    }
  }
  await walk(root, []);
  return files.sort(compare);
}
