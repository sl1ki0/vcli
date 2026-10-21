import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Architecture metadata may never redirect local reads or writes outside the project. */
export async function architectureStatePath(root: string, ...parts: string[]): Promise<string> {
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error("Invalid architecture state path component.");
  let path = await realpath(root);
  const components = [".vcli", ...parts];
  for (let index = 0; index < components.length; index++) {
    path = join(path, components[index]!);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error("Architecture state cannot contain symbolic links.");
      if (index < components.length - 1 && !info.isDirectory())
        throw new Error("Architecture state parent must be a directory.");
      if (
        index === components.length - 1 &&
        !info.isDirectory() &&
        (!info.isFile() || info.nlink > 1)
      )
        throw new Error("Architecture state requires regular files without hard links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

/** Bound reads even if a regular metadata file grows after it is opened. */
export async function readArchitectureState(
  root: string,
  parts: string[],
  maximum: number,
): Promise<string> {
  const path = await architectureStatePath(root, ...parts);
  return readArchitectureFile(path, maximum);
}

export async function readArchitectureFile(path: string, maximum: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1)
      throw new Error("Architecture state requires regular files without hard links.");
    if (info.size > maximum) throw new Error("Architecture state exceeds its size limit.");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximum) {
      const buffer = Buffer.alloc(Math.min(65_536, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new Error("Architecture state exceeds its size limit.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}
