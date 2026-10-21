import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolConversationEvent, startMessage, type RuntimeEvent } from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";

const provider = {
  id: "fixture",
  model: "fixture-model",
  contextWindow: 32_000,
  async *stream() {},
};
const at = (seconds: number) => `2026-10-13T12:00:${String(seconds).padStart(2, "0")}.000Z`;
function event(
  sessionId: string,
  type: RuntimeEvent["type"],
  data: RuntimeEvent["data"],
  seconds: number,
): RuntimeEvent {
  return { sessionId, type, data, time: at(seconds) };
}

describe("durable tool conversation history", () => {
  test("retains the final card and provider result snapshot before a tool-end event is appended", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-tool-result-snapshot-"));
    let store = await SqliteSessionStore.open(root);
    try {
      const session = await store.create(root, provider, "Finish a tool");
      const start = event(
        session.id,
        "tool-start",
        {
          callId: "finished",
          name: "file_write",
          kind: "write",
          arguments: { path: "created.py" },
        },
        1,
      );
      applyToolConversationEvent(session.chat!, start);
      await store.append(start);
      const artifact = await store.putArtifact(session.id, "Created created.py");
      const result = `Created created.py\nFull result: ${artifact}`;
      session.messages.push({
        role: "tool",
        toolCallId: "finished",
        toolName: "file_write",
        text: result,
      });
      applyToolConversationEvent(
        session.chat!,
        event(
          session.id,
          "tool-end",
          {
            callId: "finished",
            name: "file_write",
            result,
            artifact,
            isError: false,
          },
          2,
        ),
      );
      // The atomic snapshot is durable; a crash prevents the later end event append.
      await store.save(session);
      store.close();
      store = await SqliteSessionStore.open(root);
      const restored = (await store.get(session.id))!;
      expect(restored.chat).toEqual(session.chat);
      expect(restored.chat?.[0]).toMatchObject({
        status: "complete",
        tool: { state: "complete", artifact },
      });
      expect(restored.messages).toEqual(session.messages);
      expect(await store.readArtifact(artifact)).toBe("Created created.py");
      expect(await store.pendingMutations(session.id)).toEqual([]);
      await store.save(restored);
      expect((await store.get(session.id))?.chat).toEqual(session.chat);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps interrupted snapshots uncertain even with a synthetic provider result and artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-tool-uncertain-snapshot-"));
    const store = await SqliteSessionStore.open(root);
    try {
      const session = await store.create(root, provider, "Interrupted mutation");
      const start = event(
        session.id,
        "tool-start",
        {
          callId: "uncertain",
          name: "file_write",
          kind: "write",
          arguments: { path: "uncertain.py" },
        },
        1,
      );
      applyToolConversationEvent(session.chat!, start);
      await store.append(start);
      const artifact = await store.putArtifact(session.id, "Interrupted; inspect current state");
      session.messages.push({
        role: "tool",
        toolCallId: "uncertain",
        toolName: "file_write",
        text: `Interrupted; inspect current state\nFull result: ${artifact}`,
      });
      applyToolConversationEvent(
        session.chat!,
        event(
          session.id,
          "tool-end",
          {
            callId: "uncertain",
            name: "file_write",
            result: "Interrupted; inspect current state",
            artifact,
            isError: true,
            interrupted: true,
          },
          2,
        ),
      );
      await store.save(session);
      expect(await store.pendingMutations(session.id)).toEqual(["file_write"]);
      const restored = (await store.get(session.id))!;
      await store.save(restored);
      expect(await store.pendingMutations(session.id)).toEqual(["file_write"]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orders unsnapshotted migration events and recovers end-only inputs from native calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-tool-order-"));
    const store = await SqliteSessionStore.open(root);
    try {
      const session = await store.create(root, provider, "Old pending response");
      startMessage(session, "user", "Inspect a file").createdAt = at(0);
      session.messages.push({
        role: "assistant",
        text: "",
        toolCalls: [{ id: "end-only", name: "file_read", arguments: { path: "example.py" } }],
        providerData: { signature: "unchanged" },
      });
      delete session.chatToolsVersion;
      await store.save(session);
      await store.append(
        event(
          session.id,
          "message-start",
          {
            messageId: "unsaved-assistant",
            role: "assistant",
            createdAt: at(1),
          },
          1,
        ),
      );
      await store.append(
        event(
          session.id,
          "text",
          {
            messageId: "unsaved-assistant",
            text: "Reading the file",
          },
          2,
        ),
      );
      await store.append(
        event(
          session.id,
          "tool-end",
          {
            callId: "end-only",
            name: "file_read",
            result: "File not found",
            isError: true,
          },
          3,
        ),
      );
      const restored = (await store.get(session.id))!;
      expect(restored.chat?.map(({ role }) => role)).toEqual(["user", "assistant", "tool"]);
      expect(restored.chat?.[1]?.text).toBe("Reading the file");
      expect(restored.chat?.[2]?.tool).toMatchObject({
        callId: "end-only",
        target: "example.py",
        state: "failed",
      });
      expect(restored.chat?.[2]?.tool?.input).toContain("example.py");
      expect(restored.messages).toEqual(session.messages);
      await store.save(restored);
      expect((await store.get(session.id))?.chat).toEqual(restored.chat);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates calls before an old snapshot watermark without replaying saved text or provider context", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-tool-migration-"));
    let store = await SqliteSessionStore.open(root);
    try {
      const session = await store.create(root, provider, "Old compacted task");
      session.createdAt = at(0);
      const user = startMessage(session, "user", "Create the script");
      user.createdAt = at(1);
      const assistant = startMessage(session, "assistant", "Created and verified");
      assistant.createdAt = at(6);
      assistant.status = "complete";
      session.status = "complete";
      // The user-facing history survives provider context compaction independently.
      session.messages = [
        { role: "user", text: "Compacted task ledger" },
        {
          role: "assistant",
          text: "Continuation",
          providerData: { signature: "opaque-signed-continuation", payload: [1, "two"] },
        },
      ];
      const context = JSON.stringify(session.messages);
      const artifact = await store.putArtifact(session.id, "Full output\n".repeat(5000));
      for (const value of [
        event(session.id, "text", { messageId: assistant.id, text: "Created and verified" }, 2),
        event(
          session.id,
          "tool-start",
          {
            callId: "old-call",
            name: "file_write",
            kind: "write",
            arguments: { path: "dir_sizes.py", content: "print('done')" },
          },
          3,
        ),
        event(
          session.id,
          "tool-end",
          {
            callId: "old-call",
            name: "file_write",
            result: "Created dir_sizes.py",
            artifact,
            isError: false,
          },
          4,
        ),
        // Validation errors never had a tool-start event in previous releases.
        event(
          session.id,
          "tool-end",
          {
            callId: "old-error",
            name: "architecture_propose",
            result: "version must be number 1",
            isError: true,
          },
          5,
        ),
      ])
        await store.append(value);
      delete session.chatToolsVersion;
      await store.save(session);
      store.close();
      store = await SqliteSessionStore.open(root);
      const restored = (await store.get(session.id))!;
      expect(restored.chatToolsVersion).toBe(1);
      expect(restored.chat?.map(({ role }) => role)).toEqual(["user", "tool", "tool", "assistant"]);
      expect(restored.chat?.filter(({ role }) => role === "assistant")).toEqual([assistant]);
      expect(restored.chat?.find(({ tool }) => tool?.callId === "old-call")).toMatchObject({
        role: "tool",
        status: "complete",
        tool: { name: "file_write", state: "complete", artifact },
      });
      expect(restored.chat?.find(({ tool }) => tool?.callId === "old-error")).toMatchObject({
        status: "failed",
        tool: { state: "failed" },
      });
      expect(JSON.stringify(restored.messages)).toBe(context);
      expect(await store.readArtifact(artifact)).toBe("Full output\n".repeat(5000));
      expect((await store.get(session.id))?.chat).toEqual(restored.chat);
      await store.save(restored);
      store.close();
      store = await SqliteSessionStore.open(root);
      expect((await store.get(session.id))?.chat).toEqual(restored.chat);
      expect(JSON.stringify((await store.get(session.id))?.messages)).toBe(context);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers pending and failed calls after a hard process exit without replaying effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-crashed-tools-"));
    const storeModule = new URL("../apps/cli/src/store.ts", import.meta.url).pathname;
    const script = `
      import { SqliteSessionStore } from ${JSON.stringify(storeModule)};
      const root = ${JSON.stringify(root)};
      const store = await SqliteSessionStore.open(root);
      const session = await store.create(root, { id: "fixture", model: "fixture-model" }, "Interrupted tools");
      session.messages = [{ role: "assistant", text: "", providerData: { signature: "preserve-me" } }];
      await store.save(session);
      const append = (type, data) => store.append({ sessionId: session.id, type, data, time: new Date().toISOString() });
      await append("tool-request", { callId: "pending", name: "file_write", kind: "write", arguments: { path: "pending.py", content: "pending" } });
      await append("tool-start", { callId: "running", name: "shell_run", kind: "execute", arguments: { command: "python3 tests.py" } });
      await append("tool-end", { callId: "invalid", name: "architecture_propose", result: "Expected numeric version", isError: true });
      const artifact = await store.putArtifact(session.id, "Full completed output");
      await append("tool-start", { callId: "complete", name: "file_read", kind: "read", arguments: { path: "dir_sizes.py" } });
      await append("tool-end", { callId: "complete", name: "file_read", result: "Completed output", artifact, isError: false });
      console.log(session.id);
      setInterval(() => {}, 1000);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([
        child.stdout.getReader().read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Tool fixture did not become ready")), 3000);
        }),
      ]);
      clearTimeout(timer);
      const id = new TextDecoder().decode(first.value).trim();
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      child.kill("SIGKILL");
      await child.exited;
      let store = await SqliteSessionStore.open(root);
      try {
        const restored = (await store.get(id))!;
        expect(restored.chat).toHaveLength(4);
        expect(restored.status).toBe("aborted");
        for (const callId of ["pending", "running"])
          expect(restored.chat?.find(({ tool }) => tool?.callId === callId)).toMatchObject({
            status: "aborted",
            tool: { state: "interrupted" },
          });
        expect(restored.chat?.find(({ tool }) => tool?.callId === "invalid")).toMatchObject({
          status: "failed",
          tool: { state: "failed" },
        });
        const complete = restored.chat?.find(({ tool }) => tool?.callId === "complete");
        expect(complete).toMatchObject({ status: "complete", tool: { state: "complete" } });
        expect(await store.readArtifact(complete!.tool!.artifact!)).toBe("Full completed output");
        expect(restored.messages).toEqual([
          { role: "assistant", text: "", providerData: { signature: "preserve-me" } },
        ]);
        expect(await store.pendingMutations(id)).toEqual(["shell_run"]);
        // Reopening history reads only the journal and cannot execute pending tools.
        await store.save(restored);
        const db = Database.deserialize(await readFile(join(root, ".vcli/state/sessions.sqlite")));
        const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!
          .count;
        store.close();
        store = await SqliteSessionStore.open(root);
        expect((await store.get(id))?.chat).toEqual(restored.chat);
        expect((await store.get(id))?.chat).toEqual(restored.chat);
        expect(
          db.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!.count,
        ).toBe(count);
        db.close();
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
});
