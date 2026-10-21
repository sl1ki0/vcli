import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolCall, ToolContext, ToolResult } from "@vcli/core";
import { projectPath } from "./policy.ts";
import { readFileBytes } from "./file-data.ts";

const MAX_FILE_BYTES = 16 * 1024 * 1024;

interface FileState {
  exists: boolean;
  digest?: string;
  mode?: number;
}

export interface CheckpointSummary {
  id: string;
  sessionId: string;
  callId: string;
  path: string;
  createdAt: string;
  status: "pending" | "ready" | "uncertain" | "restored";
}

interface Checkpoint extends CheckpointSummary {
  version: 1;
  before: FileState;
  expectedDigest: string;
  after?: FileState;
}

const digest = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Reject links in every path component, including local checkpoint storage. */
async function checkPath(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error("Checkpoints require a file inside the project.");
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Checkpoint path contains a symbolic link: ${current}`);
      if (current !== path && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    } catch (error) {
      if (!absent(error)) throw error;
      break;
    }
  }
}

async function snapshot(
  root: string,
  path: string,
): Promise<{ state: FileState; content?: Buffer }> {
  await checkPath(root, path);
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Checkpoint requires a regular file without hard links.");
      const content = await readFileBytes(handle, MAX_FILE_BYTES);
      return {
        state: { exists: true, digest: digest(content), mode: stat.mode & 0o7777 },
        content,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!absent(error)) throw error;
    return { state: { exists: false } };
  }
}

function expectedContent(call: ToolCall, original: Buffer | undefined): Buffer {
  const args = call.arguments;
  const replacement = args.newText ?? (call.name === "files_write" ? args.content : undefined);
  if (typeof replacement !== "string") throw new Error("Checkpoint requires string file content.");
  if (args.oldText === undefined) {
    if (original !== undefined && args.overwrite !== true)
      throw new Error("Existing file requires oldText or overwrite=true.");
    return Buffer.from(replacement);
  }
  const old = String(args.oldText);
  const text = original?.toString("utf8");
  const first = text?.indexOf(old) ?? -1;
  if (!old.length || first < 0 || text!.indexOf(old, first + 1) >= 0) {
    throw new Error("oldText must match exactly once; reread the relevant span.");
  }
  return Buffer.from(text!.slice(0, first) + replacement + text!.slice(first + old.length));
}

function matches(left: FileState, right: FileState): boolean {
  return left.exists === right.exists && left.digest === right.digest && left.mode === right.mode;
}

/** Exact-file recovery for built-in edits. Shell/MCP side effects are deliberately not checkpointed. */
export class CheckpointService {
  private readonly root: Promise<string>;
  private readonly launchRoot: string;

  constructor(root: string) {
    this.launchRoot = resolve(root);
    this.root = realpath(root);
  }

  async before(call: ToolCall, context: ToolContext): Promise<string | undefined> {
    if (call.name !== "files_patch" && call.name !== "files_write") return undefined;
    context.signal.throwIfAborted();
    const root = await this.root;
    const requested = resolve(this.launchRoot, String(call.arguments.path));
    const path = inside(this.launchRoot, requested)
      ? resolve(root, relative(this.launchRoot, requested))
      : requested;
    if (path.startsWith(join(root, ".vcli") + sep))
      throw new Error("Checkpointed file edits cannot target vcli state or configuration.");
    await projectPath(root, path, { write: true });
    const previous = await snapshot(root, path);
    const expected = expectedContent(call, previous.content);
    const checkpoint: Checkpoint = {
      version: 1,
      id: randomUUID(),
      sessionId: context.sessionId,
      callId: call.id,
      path: relative(root, path),
      createdAt: new Date().toISOString(),
      status: "pending",
      before: previous.state,
      expectedDigest: digest(expected),
    };
    const directory = await this.directory(true);
    if (previous.content)
      await writeFile(join(directory, `${checkpoint.id}.before`), previous.content, {
        flag: "wx",
        mode: 0o600,
      });
    await this.save(checkpoint);
    return checkpoint.id;
  }

  async after(id: string | undefined, result?: ToolResult): Promise<void> {
    if (!id) return;
    const checkpoint = await this.load(id);
    if (checkpoint.status !== "pending") throw new Error("Checkpoint is already finalized.");
    checkpoint.status = "uncertain";
    try {
      if (result && !result.isError) {
        const current = await snapshot(await this.root, resolve(await this.root, checkpoint.path));
        if (
          current.state.digest === checkpoint.expectedDigest &&
          (!checkpoint.before.exists || current.state.mode === checkpoint.before.mode)
        ) {
          checkpoint.status = "ready";
          checkpoint.after = current.state;
        }
      }
    } finally {
      await this.save(checkpoint);
    }
  }

  async list(sessionId?: string): Promise<CheckpointSummary[]> {
    const directory = await this.directory(false);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
    const entries: CheckpointSummary[] = [];
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      const entry = await this.load(name.slice(0, -5));
      if (!sessionId || entry.sessionId === sessionId) {
        const { id, sessionId, callId, path, createdAt, status } = entry;
        entries.push({ id, sessionId, callId, path, createdAt, status });
      }
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }

  async restore(id: string, context: ToolContext): Promise<ToolResult> {
    const checkpoint = await this.load(id);
    if (checkpoint.status !== "ready" || !checkpoint.after) {
      throw new Error(
        "Only completed checkpoints can be restored. Inspect pending or uncertain mutations manually.",
      );
    }
    const root = await this.root;
    const path = await projectPath(root, checkpoint.path, { write: true });
    await context.authorizePath?.(path, true);
    const current = await snapshot(root, path);
    if (!matches(current.state, checkpoint.after))
      throw new Error(
        "File changed after this checkpoint. Restore refused to preserve external edits.",
      );
    context.signal.throwIfAborted();
    if (checkpoint.before.exists) {
      const backupPath = join(await this.directory(false), `${id}.before`);
      const backup = await snapshot(root, backupPath);
      if (!backup.content || digest(backup.content) !== checkpoint.before.digest)
        throw new Error("Checkpoint backup is missing or corrupt.");
      // Prepare the complete replacement before touching the project file.
      const temporary = join(dirname(path), `.vcli-restore-${randomUUID()}`);
      try {
        await writeFile(temporary, backup.content, { flag: "wx", mode: 0o600 });
        await chmod(temporary, checkpoint.before.mode!);
        const latest = await snapshot(root, path);
        if (!matches(latest.state, checkpoint.after))
          throw new Error("File changed during restore; no files restored.");
        context.signal.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    } else {
      const latest = await snapshot(root, path);
      if (!matches(latest.state, checkpoint.after))
        throw new Error("File changed during restore; no files restored.");
      await rm(path);
    }
    checkpoint.status = "restored";
    await this.save(checkpoint);
    return {
      text: `Restored ${checkpoint.path}. Shell and external tool effects are not included.`,
      changedPaths: [checkpoint.path],
    };
  }

  private async directory(create: boolean): Promise<string> {
    const root = await this.root;
    const directory = join(root, ".vcli", "state", "checkpoints");
    await checkPath(root, directory);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async load(id: string): Promise<Checkpoint> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid checkpoint ID.");
    const root = await this.root;
    const path = join(await this.directory(false), `${id}.json`);
    const data = await snapshot(root, path);
    if (!data.content) throw new Error("Checkpoint not found.");
    const value = JSON.parse(data.content.toString("utf8")) as Checkpoint;
    if (
      value.version !== 1 ||
      value.id !== id ||
      typeof value.path !== "string" ||
      !inside(root, resolve(root, value.path))
    )
      throw new Error("Invalid checkpoint metadata.");
    await projectPath(root, value.path, { write: true });
    return value;
  }

  private async save(checkpoint: Checkpoint): Promise<void> {
    const directory = await this.directory(true);
    const temporary = join(directory, `${checkpoint.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(checkpoint), { flag: "wx", mode: 0o600 });
      await rename(temporary, join(directory, `${checkpoint.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
