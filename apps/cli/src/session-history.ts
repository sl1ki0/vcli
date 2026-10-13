import type { Database } from "bun:sqlite";
import {
  applyConversationEvent,
  conversation,
  recoverLegacyConversation,
  recoverToolConversation,
  type RuntimeEvent,
  type Session,
} from "@vcli/core";

export interface SessionSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  status: Session["status"];
  updatedAt: string;
  tokens: number;
}

export function readSession(db: Database, id: string): Session | undefined {
  const row = db
    .query<
      { data: string; event_seq: number },
      [string]
    >("SELECT data,event_seq FROM sessions WHERE id=?")
    .get(id);
  if (!row) return;
  const session = JSON.parse(row.data) as Session;
  const legacy = session.chat === undefined;
  const chat = conversation(session);
  const migrateTools = session.chatToolsVersion !== 1;
  const storedEvents = db
    .query<{ seq: number; data: string }, [string, number]>(
      "SELECT seq,data FROM events WHERE session_id=? AND seq>? ORDER BY seq",
    )
    .all(id, migrateTools ? 0 : row.event_seq)
    .map(({ seq, data }) => ({ seq, event: JSON.parse(data) as RuntimeEvent }));
  const events = storedEvents.filter(({ seq }) => seq > row.event_seq).map(({ event }) => event);
  if (legacy) recoverLegacyConversation(session, events);
  for (const event of events) applyConversationEvent(chat, event);
  // Older snapshots already contain human text, but never contained tool cards.
  // Recover their complete tool journal, including calls before the watermark.
  if (migrateTools)
    recoverToolConversation(
      session,
      storedEvents.map(({ event }) => event),
    );
  for (const message of chat) {
    if (message.tool?.state === "requested" || message.tool?.state === "running") {
      message.tool.state = "interrupted";
      message.status = "aborted";
      if (session.status === "running") session.status = "aborted";
    }
    if (message.status === "streaming") {
      message.status = "aborted";
      if (session.status === "running") session.status = "aborted";
    }
  }
  session.chatToolsVersion = 1;
  return session;
}

export function writeSession(db: Database, session: Session): void {
  session.updatedAt = new Date().toISOString();
  // A snapshot and its event watermark commit together. Deltas stay append-only.
  db.transaction(() => {
    const seq = db
      .query<
        { seq: number },
        [string]
      >("SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?")
      .get(session.id)!.seq;
    db.query(
      `
      INSERT INTO sessions(id,root,data,event_seq) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET root=excluded.root,data=excluded.data,event_seq=excluded.event_seq
    `,
    ).run(session.id, session.root, JSON.stringify(session), seq);
    db.query(
      `
      INSERT INTO session_summaries(id,root,title,provider,model,status,updated_at,tokens) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET root=excluded.root,title=excluded.title,provider=excluded.provider,
        model=excluded.model,status=excluded.status,updated_at=excluded.updated_at,tokens=excluded.tokens
    `,
    ).run(
      session.id,
      session.root,
      session.ledger.goal.slice(0, 200),
      session.provider,
      session.model,
      session.status,
      session.updatedAt,
      session.usage.input + session.usage.output,
    );
  }).immediate();
}

/** Browsing history never deserializes large conversations or model artifacts. */
export function listSessionSummaries(db: Database, root: string, limit = 100): SessionSummary[] {
  const count = Math.max(1, Math.min(200, Math.floor(limit)));
  return db
    .query<SessionSummary, [string, number]>(
      `
    SELECT id,title,provider,model,status,updated_at AS updatedAt,tokens
    FROM session_summaries WHERE root=? ORDER BY updated_at DESC,rowid DESC LIMIT ?
  `,
    )
    .all(root, count);
}
