import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, RuntimeEvent, Session, SessionStore } from "@vcli/core";
import { initializeSessionSchema } from "./session-schema.ts";
import { listSessionSummaries, readSession, writeSession } from "./session-history.ts";

export class SqliteSessionStore implements SessionStore {
  private constructor(
    private readonly db: Database,
    private readonly artifactRoot: string,
  ) {}
  static async open(root: string): Promise<SqliteSessionStore> {
    const directory = join(root, ".vcli", "state");
    const artifacts = join(root, ".vcli", "artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const db = new Database(join(directory, "sessions.sqlite"), { create: true });
    try {
      initializeSessionSchema(db);
      return new SqliteSessionStore(db, artifacts);
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
    await writeFile(join(this.artifactRoot, id + ".txt"), content, { mode: 0o600 });
    return id;
  }
  async readArtifact(id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid artifact identifier");
    return readFile(join(this.artifactRoot, id + ".txt"), "utf8");
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
    return [...starts.values()];
  }
}
