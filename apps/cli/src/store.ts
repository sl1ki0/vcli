import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, RuntimeEvent, Session, SessionStore } from "@vcli/core";
import { initializeSessionSchema } from "./session-schema.ts";
import { listSessionSummaries, readSession, writeSession } from "./session-history.ts";
import { readStorageText, storagePath } from "./workflows/state-path.ts";

export class SqliteSessionStore implements SessionStore {
  private constructor(
    private readonly db: Database,
    private readonly artifactPath: (id: string) => Promise<string>,
  ) {}
  static async open(
    root: string,
    options: { directory?: string } = {},
  ): Promise<SqliteSessionStore> {
    const stateParts = options.directory ? [] : ["state"];
    const directory = await storagePath(root, stateParts, options.directory);
    const artifactParts = ["artifacts"];
    const artifacts = await storagePath(root, artifactParts, options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [directory, artifacts]) {
      if (path === artifacts) await mkdir(artifacts, { recursive: true, mode: 0o700 });
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        if (options.directory && path === directory && (await handle.stat()).mode & 0o077)
          throw new Error(
            "Explicit run state directory must be private; choose a directory with mode 0700.",
          );
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
    const databasePath = await storagePath(
      root,
      [...stateParts, "sessions.sqlite"],
      options.directory,
    );
    for (const suffix of ["-wal", "-shm", "-journal"])
      await storagePath(root, [...stateParts, `sessions.sqlite${suffix}`], options.directory);
    const handle = await open(
      databasePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1)
        throw new Error("Storage requires regular files without hard links.");
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const db = new Database(databasePath, { create: true });
    try {
      initializeSessionSchema(db);
      return new SqliteSessionStore(db, (id) =>
        storagePath(root, [...artifactParts, id + ".txt"], options.directory),
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  async create(root: string, provider: ProviderAdapter, goal: string): Promise<Session> {
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
    return readSession(this.db, id);
  }
  async summaries(root: string, limit = 100) {
    return listSessionSummaries(this.db, root, limit);
  }
  async list(root?: string): Promise<Session[]> {
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
    writeSession(this.db, session);
  }
  async append(event: RuntimeEvent): Promise<void> {
    this.db
      .query("INSERT INTO events(session_id,data) VALUES(?,?)")
      .run(event.sessionId, JSON.stringify(event));
  }
  async putArtifact(_sessionId: string, content: string): Promise<string> {
    const id = randomUUID();
    await writeFile(await this.artifactPath(id), content, { mode: 0o600, flag: "wx" });
    return id;
  }
  async readArtifact(id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid artifact identifier");
    return readStorageText(await this.artifactPath(id));
  }
  async pendingMutations(sessionId: string): Promise<string[]> {
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
