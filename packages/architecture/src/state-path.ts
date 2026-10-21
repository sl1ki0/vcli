import { join } from "node:path";
import { openHostFileSystem } from "@vcli/core";

/** Metadata names are fixed by the host; actual access is descriptor-rooted. */
export async function architectureStatePath(root: string, ...parts: string[]): Promise<string> {
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error("Invalid architecture state path component.");
  const filesystem = openHostFileSystem(root, {
    allowProtectedPaths: true,
  });
  try {
    const components = [".vcli", ...parts];
    for (let index = 0; index < components.length; index++) {
      const info = filesystem.stat(components.slice(0, index + 1).join("/"));
      if (info && index < components.length - 1 && !info.isDirectory())
        throw new Error("Architecture state parent must be a directory.");
    }
    return join(filesystem.root, ...components);
  } finally {
    filesystem.close();
  }
}

export async function readArchitectureState(
  root: string,
  parts: string[],
  maximum: number,
): Promise<string> {
  return readArchitectureFile(root, `.vcli/${parts.join("/")}`, maximum, true);
}

export async function readArchitectureFile(
  root: string,
  path: string,
  maximum: number,
  protectedPaths = false,
): Promise<string> {
  const filesystem = openHostFileSystem(root, { allowProtectedPaths: protectedPaths });
  try {
    return filesystem.readText(path, maximum);
  } finally {
    filesystem.close();
  }
}

export function writeArchitectureState(root: string, path: string, content: string): void {
  const filesystem = openHostFileSystem(root, { allowProtectedPaths: true });
  try {
    filesystem.writeAtomic(path, content, { mode: 0o600 });
  } finally {
    filesystem.close();
  }
}
