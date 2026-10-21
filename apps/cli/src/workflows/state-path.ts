import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Default storage is rooted at .vcli; an explicit storage directory is a trusted user choice. */
export async function storagePath(
  root: string,
  parts: string[],
  directory?: string,
): Promise<string> {
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error("Invalid storage path component.");
  let anchor = await realpath(root);
  let components = [".vcli", ...parts];
  if (directory) {
    const remaining: string[] = [];
    let parent = resolve(directory);
    while (true) {
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Storage directory must be a regular directory without symbolic links.");
        anchor = await realpath(parent);
        components = [...remaining, ...parts];
        break;
      } catch (error) {
        if (!missing(error)) throw error;
        remaining.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }
  let path = anchor;
  for (let index = 0; index < components.length; index++) {
    path = join(path, components[index]!);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Storage path cannot contain symbolic links.");
      if (index < components.length - 1 && !info.isDirectory())
        throw new Error("Storage parent must be a directory.");
      if (!info.isDirectory() && (!info.isFile() || info.nlink > 1))
        throw new Error("Storage requires regular files without hard links.");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return path;
}

export async function readStorageText(path: string, maximum = 32 * 1024 * 1024): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1)
      throw new Error("Storage requires regular files without hard links.");
    if (info.size > maximum) throw new Error("Storage document exceeds its size limit.");
    const buffer = Buffer.alloc(Math.min(maximum + 1, info.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error("Storage document exceeds its size limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
