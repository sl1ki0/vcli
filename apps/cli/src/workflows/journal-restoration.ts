import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sameFile, type JournalFile } from "./journal-snapshot.ts";
import type { ProjectPolicy } from "./policy.ts";
import { readFileBytes } from "./file-data.ts";

export interface RestorationEntry {
  destination: string;
  before?: JournalFile;
  after?: JournalFile;
}
async function currentFile(path: string): Promise<JournalFile | undefined> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Rollback refuses nonregular or hard-linked files.");
      const content = await readFileBytes(handle, 128 * 1024 * 1024);
      return {
        digest: createHash("sha256").update(content).digest("hex"),
        bytes: "",
        mode: stat.mode & 0o7777,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/** Stage every replacement, validate every hash, then commit. Conflicts never touch user files. */
export async function restoreFiles(
  entries: RestorationEntry[],
  policy: ProjectPolicy,
  persistStart: () => Promise<void>,
): Promise<void> {
  const staged = new Map<string, string>();
  try {
    for (const entry of entries) {
      if (!entry.before) continue;
      await mkdir(dirname(entry.destination), { recursive: true });
      const temporary = join(dirname(entry.destination), `.vcli-restore-${randomUUID()}`);
      await writeFile(temporary, Buffer.from(entry.before.bytes, "base64"), {
        flag: "wx",
        mode: entry.before.mode,
      });
      await chmod(temporary, entry.before.mode);
      staged.set(entry.destination, temporary);
    }
    for (const entry of entries) {
      await policy.resolvePath(entry.destination, { write: true });
      if (!sameFile(await currentFile(entry.destination), entry.after))
        throw new Error("Rollback conflict; no files were changed.");
    }
    await persistStart();
    for (const entry of entries) {
      const temporary = staged.get(entry.destination);
      if (temporary) {
        await rename(temporary, entry.destination);
        staged.delete(entry.destination);
      } else await unlink(entry.destination);
    }
  } finally {
    for (const temporary of staged.values()) await unlink(temporary).catch(() => {});
  }
}
