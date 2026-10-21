import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { RootedFileSystem } from "./rooted-filesystem.ts";
import { sandboxPrivatePath } from "./process-sandbox.ts";

/** Copy a trusted installed package through pinned capabilities, never live mounts. */
export async function materializeSandboxPackage(
  destination: string,
  trustedRoot: string,
): Promise<void> {
  const sourceRoot = await realpath(trustedRoot);
  using source = new RootedFileSystem(sourceRoot, { canonicalRoot: true });
  using target = new RootedFileSystem(destination, { canonicalRoot: true, ephemeral: true });
  let entries = 0;
  let bytes = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("MCP package exceeds the snapshot depth limit");
    for (const entry of source.list(directory, 20_000 - entries)) {
      if (++entries > 20_000) throw new Error("MCP package exceeds the snapshot entry limit");
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      if (sandboxPrivatePath(sourceRoot, join(sourceRoot, path))) continue;
      if (entry.kind === "directory") {
        target.mkdir(path);
        visit(path, depth + 1);
      } else if (entry.kind === "file") {
        const snapshot = source.snapshot(path, 64 * 1024 * 1024);
        if (!snapshot) throw new Error("MCP package changed during snapshot creation");
        bytes += snapshot.content.byteLength;
        if (bytes > 128 * 1024 * 1024)
          throw new Error("MCP package exceeds its snapshot byte limit");
        target.writeAtomic(path, snapshot.content, { mode: snapshot.mode & 0o755 });
      } else throw new Error("MCP packages cannot contain symbolic links or special files");
    }
  };
  visit(".", 0);
}
