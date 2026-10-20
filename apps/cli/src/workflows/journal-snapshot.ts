import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { projectPath, type ProjectPolicy } from "./policy.ts";

export interface JournalFile {
  digest: string;
  mode: number;
  bytes: string;
}
export type JournalTree = Record<string, JournalFile>;

/** Generated output and private configuration are explicitly outside project rollback. */
export const JOURNAL_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".vcli",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".venv",
  "__pycache__",
]);
const MAX_FILES = 20_000;
const MAX_BYTES = 128 * 1024 * 1024;

export function sameFile(left?: JournalFile, right?: JournalFile): boolean {
  return left?.digest === right?.digest && left?.mode === right?.mode;
}
export function changedFiles(left: JournalTree, right: JournalTree): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((path) => !sameFile(left[path], right[path]))
    .sort();
}

/** Never follows links and never opens .vcli/config.json, even to compute a hash. */
export async function captureTree(root: string, policy?: ProjectPolicy): Promise<JournalTree> {
  const tree: JournalTree = Object.create(null) as JournalTree;
  let bytes = 0;
  let files = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        JOURNAL_EXCLUDED_DIRECTORIES.has(entry.name) &&
        (entry.isDirectory() || entry.isSymbolicLink())
      )
        continue;
      // Environment credentials are not journal artifacts. Source and test files are never excluded.
      if (entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      const path = join(directory, entry.name);
      if (policy?.strict) {
        if (entry.isDirectory()) {
          if (!(await policy.canTraverseDirectory(path))) continue;
        } else {
          try {
            await policy.resolvePath(path);
          } catch {
            continue;
          }
        }
      }
      if (entry.isSymbolicLink()) {
        const stat = await lstat(path);
        tree[relative(root, path)] = {
          digest: `link:${stat.ino}:${stat.mtimeMs}`,
          mode: stat.mode,
          bytes: "",
        };
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Journal cannot snapshot a nonregular project entry: ${relative(root, path)}`,
        );
      await projectPath(root, path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1)
          throw new Error("Journal refuses linked or nonregular files.");
        if (++files > MAX_FILES || bytes + stat.size > MAX_BYTES)
          throw new Error("Project journal snapshot exceeds its file or byte limit.");
        const content = await handle.readFile();
        bytes += content.length;
        tree[relative(root, path).split(sep).join("/")] = {
          digest: createHash("sha256").update(content).digest("hex"),
          mode: stat.mode & 0o7777,
          bytes: content.toString("base64"),
        };
      } finally {
        await handle.close();
      }
    }
  }
  await visit(root);
  return tree;
}
