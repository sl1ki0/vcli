import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { compare, matchesPath, slash } from "./utils.ts";

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
interface IgnoreRule {
  base: string;
  pattern: string;
  negate: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function inventory(root: string, diagnostics: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string, inherited: IgnoreRule[]) {
    let rules = inherited;
    try {
      const text = await readFile(join(directory, ".gitignore"), "utf8");
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
    } catch (error) {
      if (!isMissing(error))
        diagnostics.push(
          `Could not read ${slash(relative(root, directory)) || "."}/.gitignore: ${(error as Error).message}`,
        );
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      compare(a.name, b.name),
    );
    for (const entry of entries) {
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
      if (entry.isDirectory()) await walk(absolute, rules);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root, []);
  return files.sort(compare);
}
