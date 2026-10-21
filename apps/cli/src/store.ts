import { Database } from "bun:sqlite";
import { fstatSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderAdapter, RuntimeEvent, Session, SessionStore } from "@vcli/core";
import { initializeSessionSchema } from "./session-schema.ts";
import { listSessionSummaries, readSession, writeSession } from "./session-history.ts";
import { storageFilesystem, storagePath } from "./workflows/state-path.ts";
import {
  enforceUnixMode,
  retryInterrupted,
  type RootedDirectory,
  type RootedFileExpectation,
  type RootedFileSystem,
} from "./workflows/rooted-filesystem.ts";

const MAX_DATABASE_BYTES = 128 * 1024 * 1024;

export class SqliteSessionStore implements SessionStore {
  private closed = false;
  private failed?: Error;
  private constructor(
    private readonly db: Database,
    private readonly stateFilesystem: RootedFileSystem,
    private readonly artifactFilesystem: RootedFileSystem,
    private readonly lock: RootedDirectory | undefined,
    private expected: RootedFileExpectation | null,
    private readonly readOnlySnapshot = false,
  ) {}
  static async open(
    root: string,
    options: { directory?: string; readOnlySnapshot?: boolean } = {},
  ): Promise<SqliteSessionStore> {
    const stateParts = options.directory ? [] : ["state"];
    const directory = await storagePath(root, stateParts, options.directory);
    const artifactParts = ["artifacts"];
    const artifacts = await storagePath(root, artifactParts, options.directory);
    const filesystem = storageFilesystem(directory, true);
    let artifactFilesystem: RootedFileSystem | undefined;
    let lock: RootedDirectory | undefined;
    let db: Database | undefined;
    try {
      if (options.directory && retryInterrupted(() => fstatSync(filesystem.rootFd)).mode & 0o077)
        throw new Error(
          "Explicit run state directory must be private; choose a directory with mode 0700.",
        );
      if (!options.readOnlySnapshot) {
        enforceUnixMode(filesystem.rootFd, 0o700);
        lock = filesystem.lock("sessions.sqlite.lock");
      }
      artifactFilesystem = storageFilesystem(artifacts, true);
      if (!options.readOnlySnapshot) enforceUnixMode(artifactFilesystem.rootFd, 0o700);
      // SQLite never opens project pathnames. Unknown recovery sidecars must be
      // recovered explicitly, rather than silently dropping committed WAL data.
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const name = `sessions.sqlite${suffix}`;
        const sidecar = filesystem.stat(name);
        if (sidecar && (!sidecar.isFile() || sidecar.size !== 0))
          throw new Error(
            "SQLite recovery sidecars are present. Close older vcli processes and checkpoint/recover the database with trusted SQLite before reopening; no sidecars were discarded.",
          );
        if (sidecar && !options.readOnlySnapshot)
          filesystem.withFile(name, (fd) => enforceUnixMode(fd, 0o600));
      }
      const info = filesystem.stat("sessions.sqlite");
      if (info && info.size > MAX_DATABASE_BYTES)
        throw new Error(
          "Session database exceeds 128 MiB; export or prune it locally before reopening.",
        );
      if (info && !options.readOnlySnapshot)
        filesystem.withFile("sessions.sqlite", (fd) => enforceUnixMode(fd, 0o600));
      let snapshot: ReturnType<RootedFileSystem["snapshot"]>;
      for (let attempt = 0; ; attempt++) {
        try {
          snapshot = filesystem.snapshot("sessions.sqlite", MAX_DATABASE_BYTES);
          break;
        } catch (error) {
          if (
            !options.readOnlySnapshot ||
            attempt >= 2 ||
            !(error instanceof Error) ||
            !error.message.includes("changed while reading")
          )
            throw error;
        }
      }
      if (snapshot?.content.length) {
        const bytes = Buffer.from(snapshot.content);
        // sqlite3_deserialize cannot read WAL-format headers, even after a clean
        // checkpoint. SQLite documents this rollback-format normalization.
        if (bytes.subarray(0, 16).toString("binary") === "SQLite format 3\0") {
          bytes[18] = 1;
          bytes[19] = 1;
        }
        db = Database.deserialize(bytes);
      } else db = new Database(":memory:");
      db.exec("PRAGMA journal_mode=MEMORY; PRAGMA temp_store=MEMORY;");
      initializeSessionSchema(db);
      const page = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!;
      db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / page.page_size)};`);
      const store = new SqliteSessionStore(
        db,
        filesystem,
        artifactFilesystem,
        lock,
        snapshot ? { digest: snapshot.digest, mode: snapshot.mode } : null,
        options.readOnlySnapshot,
      );
      if (!options.readOnlySnapshot) store.persist();
      return store;
    } catch (error) {
      db?.close();
      lock?.close();
      artifactFilesystem?.close();
      filesystem.close();
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock?.close();
      this.artifactFilesystem.close();
      this.stateFilesystem.close();
    }
  }

  private usable(): void {
    if (this.closed) throw new Error("Session store is closed.");
    if (this.failed) {
      const code = (this.failed as NodeJS.ErrnoException).code;
      const syscall = (this.failed as NodeJS.ErrnoException).syscall;
      const operation = syscall && /^[A-Za-z_ ]{1,64}$/.test(syscall) ? `: ${syscall}` : "";
      const diagnostic = code && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code}${operation})` : "";
      throw new Error(
        `Session persistence failed${diagnostic}; close and reopen the store before continuing.`,
        { cause: this.failed },
      );
    }
  }

  private writable(): void {
    this.usable();
    if (this.readOnlySnapshot)
      throw new Error("Read-only session snapshot cannot persist changes.");
  }

  private persist(): void {
    this.writable();
    try {
      const bytes = this.db.serialize();
      if (bytes.byteLength > MAX_DATABASE_BYTES)
        throw new Error("Session database exceeds its 128 MiB snapshot limit.");
      this.stateFilesystem.writeAtomic("sessions.sqlite", bytes, {
        expected: this.expected,
        mode: 0o600,
      });
      this.expected = { digest: createHash("sha256").update(bytes).digest("hex"), mode: 0o600 };
    } catch (error) {
      this.failed =
        error instanceof Error ? error : new Error("Unknown session persistence failure.");
      throw error;
    }
  }
  async create(root: string, provider: ProviderAdapter, goal: string): Promise<Session> {
    this.writable();
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      root,
      provider: provider.id,
      model: provider.model,
      status: "running",
      createdAt: now,
      updatedAt: now,
      messages: [],
      chat: [],
      chatToolsVersion: 1,
      ledger: {
        goal,
        constraints: [],
        decisions: [],
        pending: [goal],
        touchedPaths: [],
        verification: [],
      },
      usage: { input: 0, output: 0, cached: 0 },
    };
    await this.save(session);
    return session;
  }
  async get(id: string): Promise<Session | undefined> {
    this.usable();
    return readSession(this.db, id);
  }
  async summaries(root: string, limit = 100) {
    this.usable();
    return listSessionSummaries(this.db, root, limit);
  }
  async list(root?: string): Promise<Session[]> {
    this.usable();
    const rows = root
      ? this.db
          .query<
            { data: string },
            [string]
          >("SELECT data FROM sessions WHERE root=? ORDER BY rowid DESC")
          .all(root)
      : this.db.query<{ data: string }, []>("SELECT data FROM sessions ORDER BY rowid DESC").all();
    return rows.map((row) => JSON.parse(row.data) as Session);
  }
  async save(session: Session): Promise<void> {
    this.writable();
    writeSession(this.db, session);
    this.persist();
  }
  async append(event: RuntimeEvent): Promise<void> {
    this.writable();
    this.db
      .query("INSERT INTO events(session_id,data) VALUES(?,?)")
      .run(event.sessionId, JSON.stringify(event));
    this.persist();
  }
  async putArtifact(_sessionId: string, content: string): Promise<string> {
    this.writable();
    const id = randomUUID();
    this.artifactFilesystem.writeAtomic(`${id}.txt`, content, { expected: null, mode: 0o600 });
    return id;
  }
  async readArtifact(id: string): Promise<string> {
    this.usable();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid artifact identifier");
    return this.artifactFilesystem.readText(`${id}.txt`, 32 * 1024 * 1024);
  }
  async pendingMutations(sessionId: string): Promise<string[]> {
    this.usable();
    const starts = new Map<string, string>();
    for (const row of this.db
      .query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id=? ORDER BY seq")
      .all(sessionId)) {
      const event = JSON.parse(row.data) as RuntimeEvent;
      if (event.type === "tool-start" && event.data.kind !== "read")
        starts.set(String(event.data.callId), String(event.data.name));
      if (event.type === "tool-end") starts.delete(String(event.data.callId));
    }
    if (starts.size) {
      const row = this.db
        .query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id=?")
        .get(sessionId);
      if (row) {
        const snapshot = JSON.parse(row.data) as Session;
        const recorded = new Set(
          snapshot.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.toolCallId),
        );
        // Result snapshots include both the native result and the final card.
        // A crash before the later journal end must not make that result uncertain.
        // Synthetic interrupted results deliberately do not satisfy this evidence.
        for (const message of snapshot.chat ?? []) {
          const tool = message.tool;
          if (
            message.role === "tool" &&
            tool &&
            (tool.state === "complete" || tool.state === "failed") &&
            typeof tool.artifact === "string" &&
            tool.artifact.length > 0 &&
            starts.get(tool.callId) === tool.name &&
            recorded.has(tool.callId)
          )
            starts.delete(tool.callId);
        }
      }
    }
    return [...starts.values()];
  }
}
