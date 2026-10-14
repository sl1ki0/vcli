import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagedRun, ManagedStore } from "@vcli/core";

/** Full snapshots and budget reservations commit together; callers never observe a partial save. */
export class HomeworkStore implements ManagedStore {
  private readonly db: Database;
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    validateStatePath(this.path);
    for (const suffix of ["-wal", "-shm", "-journal"]) validateStatePath(this.path + suffix);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    validateStatePath(this.path);
    protectFile(this.path, true);
    this.db = new Database(this.path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS homework_runs (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS homework_locks (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL
    );`);
    this.protectFiles();
  }

  private protectFiles(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) protectFile(this.path + suffix);
  }

  async save(run: ManagedRun): Promise<void> {
    validateId(run.id);
    if (!Number.isSafeInteger(run.revision) || run.revision < 0)
      throw new Error("Invalid run revision");
    const revision = run.revision + 1;
    const snapshot = JSON.stringify({ ...run, revision });
    this.db
      .transaction(() => {
        const previous = this.db
          .query("SELECT revision FROM homework_runs WHERE id = ?")
          .get(run.id) as { revision: number } | null;
        if (previous ? previous.revision !== run.revision : run.revision !== 0) {
          throw new Error("Run changed in another process; reload before continuing");
        }
        this.db
          .query(
            "INSERT INTO homework_runs(id, revision, snapshot) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, snapshot=excluded.snapshot",
          )
          .run(run.id, revision, snapshot);
      })
      .immediate();
    // Never advance the caller's revision when the transaction fails.
    run.revision = revision;
    this.protectFiles();
  }

  async get(id: string): Promise<ManagedRun> {
    validateId(id);
    const row = this.db
      .query("SELECT revision, snapshot FROM homework_runs WHERE id = ?")
      .get(id) as { revision: number; snapshot: string } | null;
    if (!row) throw new Error(`Unknown run: ${id}`);
    const value: unknown = JSON.parse(row.snapshot);
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      value.id !== id ||
      !("version" in value) ||
      value.version !== 1 ||
      !("revision" in value) ||
      value.revision !== row.revision ||
      !("calls" in value) ||
      !Array.isArray(value.calls) ||
      !("messages" in value) ||
      !Array.isArray(value.messages) ||
      !("journal" in value) ||
      !value.journal ||
      typeof value.journal !== "object"
    ) {
      throw new Error("Invalid saved homework run");
    }
    return value as ManagedRun;
  }

  /** A durable process lock covers loading, model calls and effects, not just writes. */
  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    validateId(id);
    const owner = randomUUID();
    this.db
      .transaction(() => {
        const existing = this.db
          .query("SELECT owner, pid FROM homework_locks WHERE id = ?")
          .get(id) as { owner: string; pid: number } | null;
        if (existing && processAlive(existing.pid))
          throw new Error(`Run ${id} is active in another command`);
        this.db
          .query(
            "INSERT INTO homework_locks(id, owner, pid) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, pid=excluded.pid",
          )
          .run(id, owner, process.pid);
      })
      .immediate();
    try {
      this.protectFiles();
      return await operation();
    } finally {
      this.db.query("DELETE FROM homework_locks WHERE id = ? AND owner = ?").run(id, owner);
    }
  }

  close(): void {
    this.db.close();
  }
}

function validateId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    throw new Error("Invalid run_id");
}
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function validateStatePath(path: string): void {
  const ancestors: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const current of ancestors) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw new Error("Homework state rejects symbolic links and hard links");
      if (current === path ? !stat.isFile() : !stat.isDirectory())
        throw new Error("Homework state must be a regular file with directory ancestors");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
function protectFile(path: string, create = false): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Homework state rejects nonregular and linked files");
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
