import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMessage, type ProviderAdapter, type RuntimeEvent, type Session } from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { createWorkspaceHistory } from "../apps/cli/src/workspace-history.ts";

const provider: ProviderAdapter = {
  id: "fixture",
  model: "fixture-model",
  contextWindow: 32_000,
  async *stream() {
    yield { type: "done" };
  },
};
function event(
  sessionId: string,
  type: RuntimeEvent["type"],
  data: RuntimeEvent["data"],
): RuntimeEvent {
  return { sessionId, type, data, time: new Date().toISOString() };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vcli-history-"));
  const store = await SqliteSessionStore.open(root);
  return {
    root,
    store,
    clean: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("local conversation history", () => {
  test("recovers streamed chat after an unclean process exit before any response snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-crashed-history-"));
    const storeModule = new URL("../apps/cli/src/store.ts", import.meta.url).pathname;
    const coreModule = new URL("../packages/core/src/index.ts", import.meta.url).pathname;
    const script = `
      import { SqliteSessionStore } from ${JSON.stringify(storeModule)};
      import { startMessage } from ${JSON.stringify(coreModule)};
      const root = ${JSON.stringify(root)};
      const store = await SqliteSessionStore.open(root);
      const session = await store.create(root, { id: "fixture", model: "fixture-model" }, "Interrupted task");
      startMessage(session, "user", "User prompt survived");
      await store.save(session);
      const assistant = startMessage(session, "assistant");
      const append = (type, data) => store.append({ sessionId: session.id, type, data, time: new Date().toISOString() });
      await append("message-start", { messageId: assistant.id, role: "assistant", createdAt: assistant.createdAt });
      await append("text", { messageId: assistant.id, text: "Stream survived a hard exit" });
      await append("reasoning", { messageId: assistant.id, text: "Explanation survived too" });
      console.log(session.id);
      setInterval(() => {}, 1000);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([
        child.stdout.getReader().read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("History fixture did not become ready")), 3000);
        }),
      ]);
      clearTimeout(timer);
      const id = new TextDecoder().decode(first.value).trim();
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      child.kill("SIGKILL");
      await child.exited;
      const store = await SqliteSessionStore.open(root);
      try {
        const recovered = (await store.get(id))!;
        expect(recovered.chat?.map((message) => message.text)).toEqual([
          "User prompt survived",
          "Stream survived a hard exit",
        ]);
        expect(recovered.chat?.at(-1)).toMatchObject({
          reasoning: "Explanation survived too",
          status: "aborted",
        });
        expect(recovered.status).toBe("aborted");
        expect(recovered.messages).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replays uncheckpointed deltas exactly once and preserves full reasoning after interruption", async () => {
    const project = await fixture();
    try {
      const session = await project.store.create(project.root, provider, "A saved task");
      startMessage(session, "user", "Inspect this project");
      const assistant = startMessage(session, "assistant");
      await project.store.append(
        event(session.id, "message-start", {
          messageId: assistant.id,
          role: "assistant",
          createdAt: assistant.createdAt,
        }),
      );
      assistant.text = "Checkpointed ";
      await project.store.append(
        event(session.id, "text", { messageId: assistant.id, text: assistant.text }),
      );
      await project.store.save(session);
      await project.store.append(
        event(session.id, "text", { messageId: assistant.id, text: "partial answer" }),
      );
      await project.store.append(
        event(session.id, "reasoning", { messageId: assistant.id, text: "Visible explanation" }),
      );
      const restored = (await project.store.get(session.id))!;
      expect(restored.chat).toHaveLength(2);
      expect(restored.chat?.at(-1)).toMatchObject({
        text: "Checkpointed partial answer",
        reasoning: "Visible explanation",
        status: "aborted",
      });
      expect(restored.status).toBe("aborted");
      await project.store.save(restored);
      expect((await project.store.get(session.id))?.chat).toEqual(restored.chat);
      expect((await project.store.get(session.id))?.chat).toEqual(restored.chat);
    } finally {
      await project.clean();
    }
  });

  test("history selection resumes only the chosen conversation and new chat makes no empty session", async () => {
    const project = await fixture();
    try {
      const first = await project.store.create(project.root, provider, "First task");
      startMessage(first, "user", "First prompt");
      await project.store.save(first);
      const second = await project.store.create(project.root, provider, "Second task");
      let selected: string | undefined;
      const history = createWorkspaceHistory(project.root, (id) => {
        selected = id;
      });
      expect(await history.list()).toHaveLength(2);
      expect((await history.open(first.id)).chat?.[0]?.text).toBe("First prompt");
      expect(selected).toBe(first.id);
      await expect(history.open("missing")).rejects.toThrow("could not be found");
      expect(selected).toBe(first.id);
      await history.create();
      expect(selected).toBeUndefined();
      expect(await project.store.list(project.root)).toHaveLength(2);
      await history.open(second.id);
      expect(selected).toBe(second.id);
      const foreign = await project.store.create("/another-project", provider, "Foreign task");
      await expect(history.open(foreign.id)).rejects.toThrow("another project");
      expect(selected).toBe(second.id);
    } finally {
      await project.clean();
    }
  });

  test("returns bounded summaries without deserializing large session snapshots", async () => {
    const project = await fixture();
    try {
      for (let index = 0; index < 6; index++)
        await project.store.create(
          project.root,
          provider,
          `Task ${index} ` + "long title ".repeat(100),
        );
      const database = new Database(join(project.root, ".vcli/state/sessions.sqlite"));
      try {
        // A summary query must not touch conversation JSON, even when it is damaged.
        database.exec("UPDATE sessions SET data='unreadable snapshot'");
        const summaries = await project.store.summaries(project.root, 3);
        expect(summaries).toHaveLength(3);
        expect(summaries[0]?.title.startsWith("Task 5")).toBe(true);
        expect(summaries.every((summary) => summary.title.length <= 200)).toBe(true);
        expect(summaries.every((summary) => !("messages" in summary) && !("chat" in summary))).toBe(
          true,
        );
      } finally {
        database.close();
      }
    } finally {
      await project.clean();
    }
  });

  test("migrates legacy snapshots and recovers old partial text without duplicating completed answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-legacy-history-"));
    await mkdir(join(root, ".vcli/state"), { recursive: true });
    const db = new Database(join(root, ".vcli/state/sessions.sqlite"), { create: true });
    const legacy: Session = {
      id: "old-session",
      root,
      provider: provider.id,
      model: provider.model,
      status: "failed",
      createdAt: "2026-10-10T12:00:00.000Z",
      updatedAt: "2026-10-10T12:01:00.000Z",
      messages: [
        { role: "user", text: "Old prompt" },
        { role: "assistant", text: "Completed answer", providerData: { signature: "keep-me" } },
        { role: "user", text: "Follow-up" },
      ],
      ledger: {
        goal: "Old prompt",
        constraints: [],
        decisions: [],
        pending: [],
        touchedPaths: [],
        verification: [],
      },
      usage: { input: 25, output: 10, cached: 5 },
    };
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY,root TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,data TEXT NOT NULL)",
    );
    db.query("INSERT INTO sessions VALUES(?,?,?)").run(legacy.id, root, JSON.stringify(legacy));
    for (const value of [
      event(legacy.id, "text", { text: "Completed " }),
      event(legacy.id, "text", { text: "answer" }),
      event(legacy.id, "usage", {}),
      event(legacy.id, "text", { text: "Legacy partial" }),
      event(legacy.id, "status", { status: "failed" }),
    ])
      db.query("INSERT INTO events(session_id,data) VALUES(?,?)").run(
        legacy.id,
        JSON.stringify(value),
      );
    db.close();
    const store = await SqliteSessionStore.open(root);
    try {
      const restored = (await store.get(legacy.id))!;
      expect(restored.chat?.map((message) => message.text)).toEqual([
        "Old prompt",
        "Completed answer",
        "Follow-up",
        "Legacy partial",
      ]);
      expect(restored.chat?.at(-1)?.status).toBe("failed");
      expect(restored.messages[1]?.providerData).toEqual({ signature: "keep-me" });
      expect(await store.summaries(root)).toMatchObject([{ title: "Old prompt", tokens: 35 }]);
      await store.save(restored);
      expect((await store.get(legacy.id))?.chat).toEqual(restored.chat);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
