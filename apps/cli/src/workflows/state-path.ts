import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RootedFileSystem } from "./rooted-filesystem.ts";

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Default storage is rooted at .vcli; an explicit storage directory is a trusted user choice. */
export async function storagePath(
  root: string,
  parts: string[],
  directory?: string,
): Promise<string> {
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error("Invalid storage path component.");
  using projectFilesystem = new RootedFileSystem(root, { allowProtectedPaths: true });
  let anchor = projectFilesystem.root;
  let components = [".vcli", ...parts];
  if (directory) {
    const remaining: string[] = [];
    let parent = resolve(directory);
    while (true) {
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Storage directory must be a regular directory without symbolic links.");
        const parentFilesystem = new RootedFileSystem(parent, { allowProtectedPaths: true });
        try {
          anchor = parentFilesystem.root;
        } finally {
          parentFilesystem.close();
        }
        components = [...remaining, ...parts];
        break;
      } catch (error) {
        if (!missing(error)) throw error;
        if (dirname(parent) === parent) throw error;
        remaining.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }
  let path = anchor;
  using filesystem = new RootedFileSystem(anchor, {
    allowProtectedPaths: true,
    canonicalRoot: true,
  });
  for (let index = 0; index < components.length; index++) {
    path = join(path, components[index]!);
    try {
      const info = filesystem.stat(path);
      if (!info) continue;
      if (index < components.length - 1 && !info.isDirectory())
        throw new Error("Storage parent must be a directory.");
      if (!info.isDirectory() && (!info.isFile() || info.nlink > 1))
        throw new Error("Storage requires regular files without hard links.");
    } catch (error) {
      if (!missing(error))
        throw Object.assign(
          new Error(
            `Storage path refused: ${error instanceof Error ? error.message : "invalid filesystem entry"}`,
          ),
          { code: (error as NodeJS.ErrnoException).code },
        );
    }
  }
  return path;
}

export async function readStorageText(path: string, maximum = 32 * 1024 * 1024): Promise<string> {
  using filesystem = new RootedFileSystem("/", { allowProtectedPaths: true, canonicalRoot: true });
  try {
    return filesystem.readText(path, maximum);
  } catch (error) {
    if (error instanceof Error && error.message.includes("byte limit"))
      throw new Error("Storage document exceeds its size limit.");
    throw error;
  }
}

/** The caller receives a capability, not the result of a stale pathname check. */
export function storageFilesystem(directory: string, create = false): RootedFileSystem {
  if (create) {
    using filesystem = new RootedFileSystem("/", {
      allowProtectedPaths: true,
      canonicalRoot: true,
    });
    filesystem.mkdir(directory, 0o700);
  }
  return new RootedFileSystem(directory, { allowProtectedPaths: true, canonicalRoot: true });
}
