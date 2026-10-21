import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { pathInside } from "./policy.ts";
import { enforceUnixMode, RootedFileSystem } from "./rooted-filesystem.ts";

function canonicalDestination(path: string): string {
  const remaining: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(realpathSync(current), ...remaining);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      remaining.unshift(basename(current));
      current = dirname(current);
    }
  }
}

/** Atomic private records live outside all mutable project files. */
export class JournalStore {
  readonly directory: string;
  constructor(root: string, stateDirectory?: string) {
    this.directory = stateDirectory
      ? canonicalDestination(stateDirectory)
      : join(
          homedir(),
          ".local",
          "state",
          "vcli",
          "journal",
          createHash("sha256").update(root).digest("hex"),
        );
    if (pathInside(realpathSync(root), this.directory))
      throw new Error("Journal state must be outside the project.");
  }

  private async prepare(): Promise<void> {
    using filesystem = new RootedFileSystem(parse(this.directory).root, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    filesystem.mkdir(this.directory, 0o700);
    using directory = filesystem.openDirectory(this.directory);
    enforceUnixMode(directory.fd, 0o700);
  }

  private path(id: string): string {
    if (!/^[\w.-]{1,160}$/.test(id) || id === "." || id === "..")
      throw new Error("Invalid journal run identifier.");
    return join(this.directory, `${id}.json`);
  }

  async read<T>(id: string): Promise<T | undefined> {
    await this.prepare();
    const path = this.path(id);
    using filesystem = new RootedFileSystem(this.directory, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    // A bounded project snapshot may appear several times in a pending record.
    const value = filesystem.snapshot(path, 1024 * 1024 * 1024);
    return value ? (JSON.parse(value.content.toString("utf8")) as T) : undefined;
  }

  async write(id: string, document: unknown): Promise<void> {
    await this.prepare();
    const destination = this.path(id);
    using filesystem = new RootedFileSystem(this.directory, {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    filesystem.writeAtomic(destination, JSON.stringify(document), { mode: 0o600 });
  }
}
