import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolCall, ToolContext, ToolResult } from "@vcli/core";
import { projectPath } from "./policy.ts";
import { RootedFileSystem } from "./rooted-filesystem.ts";

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

async function snapshot(
  root: string,
  path: string,
): Promise<{ state: FileState; content?: Buffer }> {
  if (!inside(root, path)) throw new Error("Checkpoints require a file inside the project.");
  using filesystem = new RootedFileSystem(root, {
    allowProtectedPaths: true,
    canonicalRoot: true,
  });
  const value = filesystem.snapshot(path, MAX_FILE_BYTES);
  return value
    ? { state: { exists: true, digest: value.digest, mode: value.mode }, content: value.content }
    : { state: { exists: false } };
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
    using filesystem = new RootedFileSystem(root, { allowProtectedPaths: true });
    this.root = Promise.resolve(filesystem.root);
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
    if (previous.content) {
      using filesystem = new RootedFileSystem(root, {
        allowProtectedPaths: true,
        canonicalRoot: true,
      });
      filesystem.writeAtomic(join(directory, `${checkpoint.id}.before`), previous.content, {
        expected: null,
        mode: 0o600,
      });
    }
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
      using filesystem = new RootedFileSystem(await this.root, {
        allowProtectedPaths: true,
        canonicalRoot: true,
      });
      names = filesystem.list(directory).map((entry) => entry.name);
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
    using filesystem = new RootedFileSystem(root, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    if (checkpoint.before.exists) {
      const backupPath = join(await this.directory(false), `${id}.before`);
      const backup = await snapshot(root, backupPath);
      if (!backup.content || digest(backup.content) !== checkpoint.before.digest)
        throw new Error("Checkpoint backup is missing or corrupt.");
      context.signal.throwIfAborted();
      filesystem.writeAtomic(path, backup.content, {
        expected: { digest: checkpoint.after.digest!, mode: checkpoint.after.mode },
        mode: checkpoint.before.mode!,
      });
    } else {
      filesystem.delete(path, {
        expected: { digest: checkpoint.after.digest!, mode: checkpoint.after.mode },
      });
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
    using filesystem = new RootedFileSystem(root, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    if (create) filesystem.mkdir(directory, 0o700);
    else filesystem.stat(directory);
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
    using filesystem = new RootedFileSystem(await this.root, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    filesystem.writeAtomic(join(directory, `${checkpoint.id}.json`), JSON.stringify(checkpoint), {
      mode: 0o600,
    });
  }
}
