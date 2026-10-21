import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@vcli/core";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";

const directories: string[] = [];
const stores: SqliteSessionStore[] = [];
const provider: ProviderAdapter = {
  id: "offline",
  model: "fixture",
  contextWindow: 32_768,
  async *stream() {
    yield { type: "done" };
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vcli-private-sqlite-"));
  directories.push(root);
  return { root, database: join(root, ".vcli/state/sessions.sqlite") };
}
async function open(root: string) {
  const store = await SqliteSessionStore.open(root);
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("session snapshots and starts are durable before close without SQLite pathname sidecars", async () => {
  const { root, database } = await fixture();
  const store = await open(root);
  const session = await store.create(root, provider, "Persist fixture");
  await store.append({
    type: "tool-start",
    sessionId: session.id,
    time: new Date().toISOString(),
    data: { callId: "pending-effect", name: "files_patch", kind: "write" },
  });
  const bytes = await readFile(database);
  const snapshot = Database.deserialize(bytes);
  try {
    expect(
      snapshot.query<{ count: number }, []>("SELECT count(*) AS count FROM sessions").get()!.count,
    ).toBe(1);
    expect(
      snapshot.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!.count,
    ).toBe(1);
  } finally {
    snapshot.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    expect(await Bun.file(database + suffix).exists()).toBe(false);
  store.close();
  const restarted = await open(root);
  expect((await restarted.get(session.id))?.ledger.goal).toBe("Persist fixture");
  expect(await restarted.pendingMutations(session.id)).toEqual(["files_patch"]);
});

test("a terminal signal interrupting fsync does not poison durable session persistence", async () => {
  const { root } = await fixture();
  const module = join(import.meta.dir, "../apps/cli/src/store.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `import {mock} from 'bun:test';
import * as fs from 'node:fs';
const actual={...fs};let enabled=false,interruptions=0;
mock.module('node:fs',()=>({...actual,fsyncSync(fd){
  if(enabled&&interruptions===0){interruptions++;throw Object.assign(new Error('synthetic terminal signal'),{code:'EINTR'});}
  return actual.fsyncSync(fd);
}}));
const {SqliteSessionStore}=await import(${JSON.stringify(module)});
const root=${JSON.stringify(root)};
const store=await SqliteSessionStore.open(root);enabled=true;
const provider={id:'fixture',model:'fixture',contextWindow:32768};
const session=await store.create(root,provider,'Interrupted sync fixture');
await store.append({type:'tool-start',sessionId:session.id,time:new Date().toISOString(),data:{callId:'effect',kind:'write',name:'files_patch'}});
store.close();const restarted=await SqliteSessionStore.open(root);
if((await restarted.get(session.id))?.ledger.goal!=='Interrupted sync fixture'||(await restarted.pendingMutations(session.id))[0]!=='files_patch')process.exit(2);
restarted.close();if(interruptions!==1)process.exit(3);console.log('RECOVERED');`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("RECOVERED");
  expect(await new Response(child.stderr).text()).toBe("");
});

test("one pinned OS lock excludes other connections and processes until close", async () => {
  const { root } = await fixture();
  const first = await open(root);
  await expect(SqliteSessionStore.open(root)).rejects.toThrow("locked by another vcli process");
  const module = join(import.meta.dir, "../apps/cli/src/store.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `import {SqliteSessionStore} from ${JSON.stringify(module)};
try {const store=await SqliteSessionStore.open(${JSON.stringify(root)});store.close();process.exit(2);}
catch(error) {if(!error.message.includes('locked by another vcli process'))throw error;console.log('LOCKED');}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("LOCKED");
  expect(await new Response(child.stderr).text()).toBe("");
  first.close();
  const next = await open(root);
  expect(await next.list()).toEqual([]);
});

test("read-only immutable snapshots can browse an active writer without taking its lock", async () => {
  const { root, database } = await fixture();
  const writer = await open(root);
  const session = await writer.create(root, provider, "Active writer");
  const before = await readFile(database);
  const reader = await SqliteSessionStore.open(root, { readOnlySnapshot: true });
  stores.push(reader);
  expect((await reader.get(session.id))?.ledger.goal).toBe("Active writer");
  await expect(reader.create(root, provider, "Forbidden")).rejects.toThrow("Read-only");
  await expect(reader.save(session)).rejects.toThrow("Read-only");
  await expect(
    reader.append({
      type: "status",
      sessionId: session.id,
      time: new Date().toISOString(),
      data: {},
    }),
  ).rejects.toThrow("Read-only");
  await expect(reader.putArtifact(session.id, "forbidden")).rejects.toThrow("Read-only");
  expect(await readFile(database)).toEqual(before);
  session.ledger.goal = "Writer continues";
  await writer.save(session);
  expect((await writer.get(session.id))?.ledger.goal).toBe("Writer continues");
  expect((await reader.get(session.id))?.ledger.goal).toBe("Active writer");
});

test("unknown nonempty recovery sidecars are preserved and refuse migration", async () => {
  const { root, database } = await fixture();
  (await open(root)).close();
  const before = await readFile(database);
  await writeFile(database + "-wal", "unresolved synthetic WAL");
  await expect(SqliteSessionStore.open(root)).rejects.toThrow("recovery sidecars");
  expect(await readFile(database + "-wal", "utf8")).toBe("unresolved synthetic WAL");
  expect(await readFile(database)).toEqual(before);
});

test("a checkpointed legacy WAL header migrates entirely in memory", async () => {
  const { root, database } = await fixture();
  const original = await open(root);
  const session = await original.create(root, provider, "Legacy fixture");
  original.close();
  const bytes = await readFile(database);
  bytes[18] = bytes[19] = 2;
  await writeFile(database, bytes);
  const migrated = await open(root);
  expect((await migrated.get(session.id))?.ledger.goal).toBe("Legacy fixture");
  const rewritten = await readFile(database);
  expect(rewritten[18]).toBe(1);
  expect(rewritten[19]).toBe(1);
});

test("external database replacement is preserved and blocks further runtime bookkeeping", async () => {
  const { root, database } = await fixture();
  const store = await open(root);
  const session = await store.create(root, provider, "Fixture");
  await writeFile(database, "external edit");
  await expect(
    store.append({
      type: "status",
      sessionId: session.id,
      time: new Date().toISOString(),
      data: { status: "running" },
    }),
  ).rejects.toThrow("changed before mutation");
  await expect(store.get(session.id)).rejects.toThrow("persistence failed");
  store.close();
  expect(await readFile(database, "utf8")).toBe("external edit");
});

test("artifact capabilities retain their original directory after pathname replacement", async () => {
  const { root } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "vcli-artifact-outside-"));
  directories.push(outside);
  const store = await open(root);
  const id = await store.putArtifact("fixture", "original fixture");
  await writeFile(join(outside, `${id}.txt`), "outside fixture");
  await rename(join(root, ".vcli/artifacts"), join(root, ".vcli/original-artifacts"));
  await symlink(outside, join(root, ".vcli/artifacts"));
  expect(await store.readArtifact(id)).toBe("original fixture");
  const second = await store.putArtifact("fixture", "safe fixture");
  expect(await readFile(join(root, ".vcli/original-artifacts", `${second}.txt`), "utf8")).toBe(
    "safe fixture",
  );
  expect(await Bun.file(join(outside, `${second}.txt`)).exists()).toBe(false);
  expect(await readFile(join(outside, `${id}.txt`), "utf8")).toBe("outside fixture");
});

test("credential-bearing source paths are unavailable to native file capabilities", async () => {
  const { root } = await fixture();
  const { fileTools } = await import("../apps/cli/src/tools/files.ts");
  await mkdir(join(root, "source/.aws"), { recursive: true });
  await writeFile(join(root, "source/.aws/config"), "synthetic credential fixture");
  await writeFile(join(root, ".env"), "SYNTHETIC_KEY=fixture");
  const context = { root, sessionId: "fixture", signal: new AbortController().signal };
  for (const path of [".env", "source/.aws/config"])
    for (const name of ["files_read", "files_patch", "files_delete"])
      await expect(
        fileTools
          .find((tool) => tool.name === name)!
          .execute({ path, newText: "replacement", overwrite: true }, context),
      ).rejects.toThrow();
  expect(await readFile(join(root, ".env"), "utf8")).toBe("SYNTHETIC_KEY=fixture");
  expect(await readFile(join(root, "source/.aws/config"), "utf8")).toBe(
    "synthetic credential fixture",
  );
});
