import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedJournal, ManagedRun, RunFile, RunTree } from "@vcli/core";
import type { HomeworkPolicy } from "./policy.ts";

const MAX_FILES = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** Snapshots include all project files, including denied directories. No source/test exclusions. */
export class HomeworkJournal implements ManagedJournal {
  constructor(private readonly policy: HomeworkPolicy) {}

  async capture(): Promise<RunTree> {
    const tree: RunTree = Object.create(null) as RunTree;
    let bytes = 0;
    let files = 0;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Journal refuses linked or special directories");
      for (const entry of (await readdir(directory)).sort()) {
        const path = prefix ? `${prefix}/${entry}` : entry;
        validatePath(path);
        const absolute = join(directory, entry);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error(`Journal refuses symlink: ${path}`);
        if (info.isDirectory()) {
          await visit(absolute, path);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1)
          throw new Error(`Journal refuses linked or special file: ${path}`);
        if (++files > MAX_FILES || info.size > MAX_BYTES - bytes)
          throw new Error("Journal snapshot limit exceeded (10,000 files / 16 MiB)");
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const current = await handle.stat();
          if (
            !current.isFile() ||
            current.nlink !== 1 ||
            current.ino !== info.ino ||
            current.dev !== info.dev
          )
            throw new Error(`File changed while snapshotting: ${path}`);
          // Bound reads even if another process grows the file between stat and read.
          const buffer = Buffer.alloc(Math.min(MAX_BYTES - bytes + 1, current.size + 1));
          let length = 0;
          while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const final = await handle.stat();
          if (
            length !== current.size ||
            final.size !== current.size ||
            final.mtimeMs !== current.mtimeMs ||
            final.ctimeMs !== current.ctimeMs
          )
            throw new Error(`File changed while snapshotting: ${path}`);
          bytes += length;
          if (bytes > MAX_BYTES) throw new Error("Journal snapshot limit exceeded (16 MiB)");
          const content = buffer.subarray(0, length);
          tree[path] = {
            content: content.toString("base64"),
            hash: hash(content),
            mode: current.mode & 0o7777,
          };
        } finally {
          await handle.close();
        }
      }
    };
    await visit(this.policy.root, "");
    return tree;
  }

  async before(run: ManagedRun): Promise<void> {
    validateJournal(run);
    const current = await this.capture();
    const changed = differences(run.journal.expected, current);
    if (changed.length) throw new Error(`Project conflict before action: ${changed.join(", ")}`);
    // A new independent snapshot is saved with the started call before any effect.
    run.journal.expected = current;
  }

  async after(run: ManagedRun): Promise<void> {
    validateJournal(run);
    const current = await this.capture();
    const touched = [
      ...new Set([
        ...run.journal.changes.map((change) => change.path),
        ...differences(run.journal.expected, current),
      ]),
    ].sort();
    run.journal.expected = current;
    run.journal.changes = touched.map((path) => ({
      path,
      before: run.journal.initial[path],
      after: current[path],
    }));
  }

  async inspect(run: ManagedRun): Promise<string> {
    validateJournal(run);
    const sections = run.journal.changes.map(({ path, before, after }) =>
      renderChange(path, before, after),
    );
    const current = await this.capture();
    const unsettled = differences(run.journal.expected, current);
    if (unsettled.length) {
      sections.push(
        `Current tree differs from saved state (not attributed to this run):\n${unsettled.map((path) => renderChange(path, run.journal.expected[path], current[path])).join("\n")}`,
      );
    }
    return sections.join("\n") || "No file changes.";
  }

  async rollback(run: ManagedRun): Promise<void> {
    validateJournal(run);
    if (
      run.status === "uncertain" ||
      run.calls.some((call) => call.state === "started" || call.state === "uncertain")
    )
      throw new Error(
        "Resolve uncertain actions and explicitly attribute their changes before rollback",
      );
    if (run.status === "rolled-back") throw new Error("Run is already rolled back");
    const changes = run.journal.changes;
    const current = await this.capture();
    const destinations: { path: string; absolute: string; before?: RunFile; after?: RunFile }[] =
      [];
    // Validate every file and every restore destination before touching a single path.
    for (const change of changes) {
      if (!same(current[change.path], change.after))
        throw new Error(`Rollback conflict: ${change.path} changed outside this run`);
      const absolute = await this.policy.path(change.path, "file");
      destinations.push({ ...change, absolute });
    }
    const staged: { temporary: string; absolute: string; mode: number }[] = [];
    try {
      for (const destination of destinations) {
        if (!destination.before || same(destination.before, destination.after)) continue;
        await mkdir(dirname(destination.absolute), { recursive: true });
        // Recheck after creating parents; the policy rejects unsafe ancestor links.
        await this.policy.path(destination.path, "file");
        const temporary = join(dirname(destination.absolute), `.vcli-rollback-${randomUUID()}`);
        const handle = await open(temporary, "wx", 0o600);
        staged.push({ temporary, absolute: destination.absolute, mode: destination.before.mode });
        try {
          await handle.writeFile(Buffer.from(destination.before.content, "base64"));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, destination.before.mode);
      }
      // Staging can take time. Recheck every destination before any restoration or deletion.
      for (const destination of destinations) {
        const absolute = await this.policy.path(destination.path, "file");
        if (!same(await readCurrentFile(absolute), destination.after))
          throw new Error(
            `Rollback conflict: ${destination.path} changed while preparing restoration`,
          );
      }
      // A preflight conflict never reaches these writes. Unrelated files remain untouched.
      for (const destination of destinations) {
        if (!destination.before && destination.after) await unlink(destination.absolute);
      }
      for (const file of staged) await rename(file.temporary, file.absolute);
    } finally {
      for (const file of staged)
        await unlink(file.temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    run.journal.expected = await this.capture();
    // Retain original backups and the attributable diff as an audit trail.
    run.status = "rolled-back";
  }
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
function same(a?: RunFile, b?: RunFile): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && a.hash === b.hash && a.mode === b.mode;
}
function differences(a: RunTree, b: RunTree): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((path) => !same(a[path], b[path]));
}
function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe journal path: ${path}`);
}
function validateFile(file: RunFile): void {
  if (
    !file ||
    typeof file.content !== "string" ||
    typeof file.hash !== "string" ||
    !Number.isInteger(file.mode) ||
    file.mode < 0 ||
    file.mode > 0o7777
  )
    throw new Error("Invalid journal file backup");
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.toString("base64") !== file.content || hash(bytes) !== file.hash)
    throw new Error("Journal backup hash mismatch");
}
function validateJournal(run: ManagedRun): void {
  for (const tree of [run.journal.initial, run.journal.expected]) {
    for (const [path, file] of Object.entries(tree)) {
      validatePath(path);
      validateFile(file);
    }
  }
  const expected = differences(run.journal.initial, run.journal.expected);
  if (new Set(run.journal.changes.map((change) => change.path)).size !== run.journal.changes.length)
    throw new Error("Duplicate journal change");
  for (const change of run.journal.changes) {
    validatePath(change.path);
    if (change.before) validateFile(change.before);
    if (change.after) validateFile(change.after);
    if (
      !same(change.before, run.journal.initial[change.path]) ||
      (run.status !== "rolled-back" && !same(change.after, run.journal.expected[change.path]))
    )
      throw new Error("Journal change does not match snapshots");
  }
  if (
    run.status !== "rolled-back" &&
    expected.some((path) => !run.journal.changes.some((change) => change.path === path))
  )
    throw new Error("Journal changes do not cover saved tree");
}
function renderChange(path: string, before?: RunFile, after?: RunFile): string {
  if (same(before, after))
    return `Touched ${path}: final state equals original (${before ? "file restored to its original contents and mode" : "created then deleted"}); no net diff.`;
  const header = `--- ${before ? `a/${path}` : "/dev/null"}\n+++ ${after ? `b/${path}` : "/dev/null"}`;
  const a = before ? Buffer.from(before.content, "base64") : Buffer.alloc(0);
  const b = after ? Buffer.from(after.content, "base64") : Buffer.alloc(0);
  if (
    a.includes(0) ||
    b.includes(0) ||
    !Buffer.from(a.toString("utf8")).equals(a) ||
    !Buffer.from(b.toString("utf8")).equals(b)
  )
    return `${header}\nBinary content changed (${a.length} -> ${b.length} bytes)`;
  const lines = (buffer: Buffer, sign: string) =>
    buffer.length
      ? buffer
          .toString("utf8")
          .split("\n")
          .map((line) => `${sign}${line}`)
          .join("\n")
      : "";
  const mode =
    before?.mode !== after?.mode
      ? `\nMode: ${before?.mode.toString(8) ?? "absent"} -> ${after?.mode.toString(8) ?? "absent"}`
      : "";
  return `${header}${mode}\n@@ complete file @@\n${[lines(a, "-"), lines(b, "+")].filter(Boolean).join("\n")}`;
}

async function readCurrentFile(path: string): Promise<RunFile | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES)
      throw new Error("Unsafe rollback destination");
    const content = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < content.length) {
      const result = await handle.read(content, length, content.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const final = await handle.stat();
    if (
      length !== info.size ||
      final.size !== info.size ||
      final.mtimeMs !== info.mtimeMs ||
      final.ctimeMs !== info.ctimeMs
    )
      throw new Error("Rollback conflict while reading destination");
    const bytes = content.subarray(0, length);
    return { content: bytes.toString("base64"), hash: hash(bytes), mode: info.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}
