import type { Database } from "bun:sqlite";

/** Migrate old session snapshots without changing their provider continuations. */
export function initializeSessionSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, data TEXT NOT NULL,
        event_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS summaries_project ON session_summaries(root, updated_at DESC);
    `);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
    if (!columns.some(({ name }) => name === "event_seq"))
      db.exec("ALTER TABLE sessions ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      INSERT OR IGNORE INTO session_summaries
      SELECT id, root, substr(json_extract(data, '$.ledger.goal'), 1, 200),
        json_extract(data, '$.provider'), json_extract(data, '$.model'),
        json_extract(data, '$.status'), json_extract(data, '$.updatedAt'),
        coalesce(json_extract(data, '$.usage.input'), 0) + coalesce(json_extract(data, '$.usage.output'), 0)
      FROM sessions WHERE id NOT IN (SELECT id FROM session_summaries);
    `);
  }).immediate();
}
