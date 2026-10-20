import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { pathInside } from "./policy.ts";

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
    const root = parse(this.directory).root;
    let current = root;
    for (const part of this.directory.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Journal directory cannot contain symbolic links.");
    }
    if ((await realpath(this.directory)) !== this.directory)
      throw new Error("Journal directory must be canonical.");
  }

  private path(id: string): string {
    if (!/^[\w.-]{1,160}$/.test(id) || id === "." || id === "..")
      throw new Error("Invalid journal run identifier.");
    return join(this.directory, `${id}.json`);
  }

  async read<T>(id: string): Promise<T | undefined> {
    await this.prepare();
    const path = this.path(id);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile())
          throw new Error("Journal record must be a regular file.");
        return JSON.parse(await handle.readFile("utf8")) as T;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  async write(id: string, document: unknown): Promise<void> {
    await this.prepare();
    const destination = this.path(id);
    const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(document), { flag: "wx", mode: 0o600 });
      const handle = await open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
