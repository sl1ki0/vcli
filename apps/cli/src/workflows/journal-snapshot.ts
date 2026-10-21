import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { ProjectPolicy } from "./policy.ts";
import { RootedFileSystem } from "./rooted-filesystem.ts";
import { privateProjectPath } from "./private-path.ts";

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
  using filesystem = new RootedFileSystem(root, { canonicalRoot: true });
  const tree: JournalTree = Object.create(null) as JournalTree;
  let bytes = 0;
  let files = 0;
  let totalEntries = 0;
  async function visit(directory: string, depth = 0): Promise<void> {
    if (depth > 128) throw new Error("Project journal directory depth exceeds its limit.");
    const entries = filesystem.list(directory, MAX_FILES);
    for (const entry of entries) {
      if (++totalEntries > MAX_FILES)
        throw new Error("Project journal snapshot exceeds its entry limit.");
      if (privateProjectPath(entry.name)) continue;
      if (
        JOURNAL_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) &&
        (entry.kind === "directory" || entry.kind === "symlink")
      )
        continue;
      // Environment credentials are not journal artifacts. Source and test files are never excluded.
      if (entry.name.toLowerCase() === ".env" || entry.name.toLowerCase().startsWith(".env."))
        continue;
      const path = join(directory, entry.name);
      if (policy?.strict) {
        if (entry.kind === "directory") {
          if (!(await policy.canTraverseDirectory(path))) continue;
        } else {
          try {
            await policy.resolvePath(path);
          } catch {
            continue;
          }
        }
      }
      if (entry.kind === "symlink") {
        tree[relative(root, path)] = {
          digest: `link:${createHash("sha256").update(filesystem.readLink(path)).digest("hex")}`,
          mode: 0o120777,
          bytes: "",
        };
        continue;
      }
      if (entry.kind === "directory") {
        await visit(path, depth + 1);
        continue;
      }
      if (entry.kind !== "file")
        throw new Error(
          `Journal cannot snapshot a nonregular project entry: ${relative(root, path)}`,
        );
      if (++files > MAX_FILES)
        throw new Error("Project journal snapshot exceeds its file or byte limit.");
      const snapshot = filesystem.snapshot(path, MAX_BYTES - bytes);
      if (!snapshot) throw new Error("Project changed while taking a journal snapshot.");
      bytes += snapshot.content.length;
      tree[relative(root, path).split(sep).join("/")] = {
        digest: snapshot.digest,
        mode: snapshot.mode,
        bytes: snapshot.content.toString("base64"),
      };
    }
  }
  await visit(root);
  return tree;
}
