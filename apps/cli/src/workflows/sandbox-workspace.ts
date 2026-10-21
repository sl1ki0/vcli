import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RootedFileSystem, type RootedFileSnapshot } from "./rooted-filesystem.ts";
import { privateProjectPath } from "./private-path.ts";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
class Tree extends Map<string, RootedFileSnapshot> {
  readonly directories = new Set<string>();
}
const commits = new Map<string, Promise<void>>();

export interface SandboxWorkspaceOptions {
  root: string;
  access: "read" | "write";
  allowGitRead?: boolean;
  authorizePath?: (path: string, write?: boolean) => Promise<string>;
}

function privatePath(path: string, git = false): boolean {
  if (path.split("/").some((part) => part.toLowerCase() === ".vcli-plugins")) return true;
  if (git && (path === ".git" || path.startsWith(".git/")))
    return privateProjectPath(path.slice(5));
  return privateProjectPath(path);
}

function same(
  left: RootedFileSnapshot | undefined,
  right: RootedFileSnapshot | undefined,
): boolean {
  return left?.digest === right?.digest && left?.mode === right?.mode;
}

/** A copied tree, never a writable host mount. Keep the pinned source open until teardown. */
export async function createSandboxWorkspace(options: SandboxWorkspaceOptions) {
  const launchRoot = resolve(options.root);
  const source = new RootedFileSystem(options.root, {
    allowProtectedPaths: options.allowGitRead,
  });
  const originalRoot = source.root;
  const temporary = await mkdtemp(join(tmpdir(), "vcli-workspace-"));
  const root = await realpath(temporary);
  const staged = new RootedFileSystem(root, {
    canonicalRoot: true,
    allowProtectedPaths: options.allowGitRead,
    ephemeral: true,
  });
  let baseline = new Tree();
  let stageBaseline = new Tree();
  let disposed = false;

  const mapPath = (input: string): string => {
    if (input.includes("\0") || input.split(/[\\/]/).includes(".."))
      throw new Error("Sandbox paths cannot contain traversal.");
    const requested = resolve(launchRoot, input);
    const launchRelative = relative(launchRoot, requested);
    const path =
      launchRelative !== ".." &&
      !launchRelative.startsWith(`..${sep}`) &&
      !isAbsolute(launchRelative)
        ? resolve(originalRoot, launchRelative)
        : requested;
    const part = relative(originalRoot, path);
    if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new Error("Sandbox paths must remain inside the project.");
    return join(root, part);
  };

  const tree = async (filesystem: RootedFileSystem, host: boolean): Promise<Tree> => {
    const result = new Tree();
    let entries = 0;
    let expectedBytes = 0;
    const files: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error("Sandbox workspace exceeds its depth limit.");
      for (const entry of filesystem.list(directory, MAX_ENTRIES - entries)) {
        if (++entries > MAX_ENTRIES) throw new Error("Sandbox workspace exceeds its entry limit.");
        const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (privatePath(path, options.allowGitRead)) continue;
        // Generated dependencies/artifacts are not implicit host filesystem grants.
        if (["node_modules", "dist", ".cache", "coverage"].includes(entry.name)) continue;
        if (entry.kind === "directory") {
          result.directories.add(path);
          await visit(path, depth + 1);
          continue;
        }
        if (entry.kind !== "file") {
          if (!host)
            throw new Error(`Sandbox output contains an unsupported link or special file: ${path}`);
          continue;
        }
        if (host && options.authorizePath && !path.startsWith(".git/")) {
          try {
            await options.authorizePath(join(originalRoot, path), false);
          } catch {
            continue;
          }
        }
        const stat = filesystem.stat(path);
        if (!stat?.isFile()) throw new Error("Sandbox source changed during snapshot creation.");
        if (stat.size > MAX_FILE_BYTES) throw new Error("Sandbox file exceeds its byte limit.");
        expectedBytes += stat.size;
        if (expectedBytes > MAX_BYTES) throw new Error("Sandbox workspace exceeds its byte limit.");
        files.push(path);
      }
    };
    // Reject oversized trees from metadata before allocating source-content buffers.
    await visit(".", 0);
    let bytes = 0;
    for (const path of files) {
      const snapshot = filesystem.snapshot(path, MAX_FILE_BYTES);
      if (!snapshot) throw new Error("Sandbox source changed during snapshot creation.");
      bytes += snapshot.content.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Sandbox workspace exceeds its byte limit.");
      result.set(path, snapshot);
    }
    return result;
  };

  const copy = (next: Tree): void => {
    for (const path of stageBaseline.keys()) if (!next.has(path)) staged.delete(path);
    for (const path of [...stageBaseline.directories].sort((a, b) => b.length - a.length))
      if (!next.directories.has(path)) staged.removeDirectory(path);
    for (const path of next.directories) staged.mkdir(path);
    for (const [path, value] of next)
      if (!same(stageBaseline.get(path), value))
        staged.writeAtomic(path, value.content, { mode: value.mode & 0o777 });
    stageBaseline = new Tree(
      [...next].map(([path, value]) => [path, { ...value, mode: value.mode & 0o777 }]),
    );
    for (const path of next.directories) stageBaseline.directories.add(path);
  };

  const assertClean = async (): Promise<void> => {
    const current = await tree(staged, false);
    if (
      current.size !== stageBaseline.size ||
      current.directories.size !== stageBaseline.directories.size ||
      [...current.directories].some((path) => !stageBaseline.directories.has(path)) ||
      [...current].some(([path, value]) => !same(value, stageBaseline.get(path)))
    )
      throw new Error(
        "Sandbox changed outside an authorized request; restart the process before continuing.",
      );
  };

  const refresh = async (): Promise<void> => {
    if (disposed) throw new Error("Sandbox workspace is closed.");
    await assertClean();
    const next = await tree(source, true);
    copy(next);
    baseline = next;
  };

  const commit = async (): Promise<void> => {
    if (disposed) throw new Error("Sandbox workspace is closed.");
    const previous = commits.get(originalRoot) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const next = previous.catch(() => {}).then(() => gate);
    commits.set(originalRoot, next);
    await previous.catch(() => {});
    try {
      const current = await tree(staged, false);
      const paths = [...new Set([...stageBaseline.keys(), ...current.keys()])].filter(
        (path) => !same(stageBaseline.get(path), current.get(path)),
      );
      const createdDirectories = [...current.directories].filter(
        (path) => !baseline.directories.has(path),
      );
      const removedDirectories = [...baseline.directories].filter(
        (path) => !current.directories.has(path),
      );
      if (
        (paths.length || createdDirectories.length || removedDirectories.length) &&
        options.access !== "write"
      )
        throw new Error("Read-only sandbox attempted to change project files.");
      // Validate every touched path before applying the first change.
      for (const path of paths) {
        if (path === ".git" || path.startsWith(".git/"))
          throw new Error("Sandbox cannot modify Git metadata.");
        await options.authorizePath?.(join(originalRoot, path), true);
        if (!same(source.snapshot(path, MAX_FILE_BYTES), baseline.get(path)))
          throw new Error(
            `Project changed while the sandbox was running: ${path}. No changes were imported.`,
          );
      }
      for (const path of [...createdDirectories, ...removedDirectories]) {
        if (path === ".git" || path.startsWith(".git/"))
          throw new Error("Sandbox cannot modify Git metadata.");
        await options.authorizePath?.(join(originalRoot, path), true);
        const exists = source.stat(path);
        if (createdDirectories.includes(path) ? exists !== undefined : !exists?.isDirectory())
          throw new Error(`Project directory changed while the sandbox was running: ${path}`);
      }
      for (const directory of removedDirectories) {
        const expectedChildren = new Map<string, "file" | "directory">();
        for (const path of baseline.keys())
          if (dirname(path) === directory)
            expectedChildren.set(path.slice(directory.length + 1), "file");
        for (const path of baseline.directories)
          if (dirname(path) === directory)
            expectedChildren.set(path.slice(directory.length + 1), "directory");
        const children = source.list(directory, MAX_ENTRIES);
        if (
          children.length !== expectedChildren.size ||
          children.some((entry) => expectedChildren.get(entry.name) !== entry.kind)
        )
          throw new Error(
            `Project directory changed while the sandbox was running: ${directory}. No changes were imported.`,
          );
      }
      let applied = 0;
      try {
        for (const path of createdDirectories.sort((a, b) => a.length - b.length))
          source.mkdir(path);
        for (const path of paths) {
          const value = current.get(path);
          const expected = baseline.get(path) ?? null;
          if (value)
            source.writeAtomic(path, value.content, { mode: value.mode & 0o777, expected });
          else source.delete(path, { expected: expected ?? undefined });
          applied++;
        }
        for (const path of removedDirectories.sort((a, b) => b.length - a.length))
          source.removeDirectory(path);
      } catch (error) {
        throw new Error(
          `Sandbox import stopped after ${applied} file changes. Inspect the run journal before retrying.`,
          { cause: error },
        );
      }
      const hostBaseline = new Tree(
        [...current].map(([path, value]) => [
          path,
          paths.includes(path) ? value : (baseline.get(path) ?? value),
        ]),
      );
      for (const path of current.directories) hostBaseline.directories.add(path);
      baseline = hostBaseline;
      stageBaseline = current;
    } finally {
      release();
      if (commits.get(originalRoot) === next) {
        await next;
        commits.delete(originalRoot);
      }
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    staged.close();
    source.close();
    await rm(temporary, { recursive: true, force: true });
  };
  try {
    baseline = await tree(source, true);
    copy(baseline);
    return { root, originalRoot, cwd: mapPath, mapPath, refresh, commit, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
