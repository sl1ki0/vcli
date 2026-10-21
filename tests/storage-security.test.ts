import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";

test("existing broad storage modes are tightened before writing private transcripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-storage-modes-"));
  const root = join(directory, "project");
  await mkdir(root);
  let store: SqliteSessionStore | undefined;
  try {
    store = await SqliteSessionStore.open(root);
    store.close();
    store = undefined;
    const state = join(root, ".vcli/state"),
      artifacts = join(root, ".vcli/artifacts");
    const database = join(state, "sessions.sqlite");
    await chmod(state, 0o755);
    await chmod(artifacts, 0o755);
    await chmod(database, 0o644);
    store = await SqliteSessionStore.open(root);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect((await stat(artifacts)).mode & 0o777).toBe(0o700);
    expect((await stat(database)).mode & 0o777).toBe(0o600);
    const id = await store.putArtifact("fixture", "private fixture");
    expect((await stat(join(artifacts, `${id}.txt`))).mode & 0o777).toBe(0o600);
    for (const name of await readdir(state))
      if (name.startsWith("sessions.sqlite-"))
        expect((await stat(join(state, name))).mode & 0o777).toBe(0o600);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a shared explicit state directory is refused without changing its permissions or contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-storage-shared-"));
  const root = join(directory, "project"),
    shared = join(directory, "shared");
  try {
    await mkdir(root);
    await mkdir(shared, { mode: 0o755 });
    await expect(SqliteSessionStore.open(root, { directory: shared })).rejects.toThrow(
      "must be private",
    );
    expect((await stat(shared)).mode & 0o777).toBe(0o755);
    expect(await readdir(shared)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session storage refuses linked directories before creating SQLite or artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-storage-security-"));
  const root = join(directory, "project"),
    outside = join(directory, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    for (const relative of [".vcli", ".vcli/state", ".vcli/artifacts"]) {
      await mkdir(join(root, ".vcli"), { recursive: true });
      if (relative === ".vcli") await rm(join(root, ".vcli"), { recursive: true });
      await symlink(outside, join(root, relative));
      await expect(SqliteSessionStore.open(root)).rejects.toThrow("symbolic links");
      expect(await readdir(outside)).toEqual([]);
      await rm(join(root, ".vcli"), { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite database and sidecar links cannot redirect storage writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-storage-security-"));
  const root = join(directory, "project"),
    outside = join(directory, "outside.txt");
  try {
    await mkdir(join(root, ".vcli/state"), { recursive: true });
    await writeFile(outside, "external content");
    for (const name of [
      "sessions.sqlite",
      "sessions.sqlite-wal",
      "sessions.sqlite-shm",
      "sessions.sqlite-journal",
    ]) {
      const target = join(root, ".vcli/state", name);
      for (const createLink of [symlink, link]) {
        await createLink(outside, target);
        await expect(SqliteSessionStore.open(root)).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe("external content");
        await rm(target);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact retrieval rejects a linked result even when the identifier is valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-storage-security-"));
  const root = join(directory, "project"),
    outside = join(directory, "outside.txt");
  await mkdir(root);
  const store = await SqliteSessionStore.open(root);
  try {
    const id = await store.putArtifact("fixture", "original result");
    const target = join(root, ".vcli/artifacts", `${id}.txt`);
    await writeFile(outside, "external private fixture");
    await rm(target);
    await symlink(outside, target);
    await expect(store.readArtifact(id)).rejects.toThrow("symbolic links");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
