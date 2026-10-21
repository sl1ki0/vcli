import { createHash } from "node:crypto";
import { sameFile, type JournalFile } from "./journal-snapshot.ts";
import type { ProjectPolicy } from "./policy.ts";
import { RootedFileSystem } from "./rooted-filesystem.ts";

export interface RestorationEntry {
  destination: string;
  before?: JournalFile;
  after?: JournalFile;
}
/** Prepare every byte and validate every path/hash before starting durable rollback. */
export async function restoreFiles(
  entries: RestorationEntry[],
  policy: ProjectPolicy,
  persistStart: () => Promise<void>,
): Promise<void> {
  using filesystem = new RootedFileSystem(policy.root, { canonicalRoot: true });
  const staged = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.before && !entry.after) throw new Error("Invalid empty rollback entry.");
    if (entry.before) {
      if (
        !Number.isInteger(entry.before.mode) ||
        entry.before.mode < 0 ||
        entry.before.mode > 0o7777
      )
        throw new Error("Rollback snapshot mode is corrupt; no files were changed.");
      const bytes = Buffer.from(entry.before.bytes, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== entry.before.digest)
        throw new Error("Rollback snapshot is corrupt; no files were changed.");
      staged.set(entry.destination, bytes);
    }
    await policy.resolvePath(entry.destination, { write: true });
    const current = filesystem.snapshot(entry.destination, 128 * 1024 * 1024);
    if (
      !sameFile(current && { digest: current.digest, mode: current.mode, bytes: "" }, entry.after)
    )
      throw new Error("Rollback conflict; no files were changed.");
  }
  await persistStart();
  for (const entry of entries) {
    const content = staged.get(entry.destination);
    if (content) {
      filesystem.writeAtomic(entry.destination, content, {
        expected: entry.after ?? null,
        mode: entry.before!.mode,
      });
    } else {
      filesystem.delete(entry.destination, { expected: entry.after });
    }
  }
}
