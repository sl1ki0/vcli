import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { estimateTokens, type ToolDefinition } from "@vcli/core";
import { objectSchema, stringSchema } from "../tools/schema.ts";
import { retryInterrupted, RootedFileSystem } from "./rooted-filesystem.ts";

const MEMORY_PATH = ".vcli/MEMORY.md";
const SOURCE_PATHS = ["AGENTS.md", "CLAUDE.md", MEMORY_PATH];
const MAX_FILE_BYTES = 24_000;
const DEFAULT_TOKEN_BUDGET = 2_000;

export interface ProjectMemory {
  text: string;
  sources: { path: string; revision: string; truncated: boolean }[];
  diagnostics: string[];
}

function revision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function prefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  let end = Math.min(encoded.length, Math.max(0, bytes));
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

async function readBounded(
  root: string,
  source: string,
): Promise<{ text: string; truncated: boolean }> {
  using filesystem = new RootedFileSystem(root, { allowProtectedPaths: true });
  return filesystem.withFile(source, (fd) => {
    const stats = retryInterrupted(() => fstatSync(fd, { bigint: true }));
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const bytesRead = retryInterrupted(() => readSync(fd, buffer, 0, buffer.length, 0));
    const after = retryInterrupted(() => fstatSync(fd, { bigint: true }));
    if (
      stats.size !== after.size ||
      stats.mtimeNs !== after.mtimeNs ||
      stats.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error("Instruction source changed while reading; retry after writes finish.");
    const truncated = bytesRead > MAX_FILE_BYTES || stats.size > BigInt(MAX_FILE_BYTES);
    let end = Math.min(bytesRead, MAX_FILE_BYTES);
    while (truncated && end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    return { text: buffer.subarray(0, end).toString("utf8"), truncated };
  });
}

/** Reload per run. Only root instructions are automatic; nested instructions need explicit reads. */
export async function loadProjectMemory(
  root: string,
  options: { userInstructions?: string; tokenBudget?: number } = {},
): Promise<ProjectMemory> {
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isInteger(budget) || budget < 0 || budget > 8_000)
    throw new Error("Memory token budget must be an integer between 0 and 8000.");
  const memory: ProjectMemory = { text: "", sources: [], diagnostics: [] };
  const sections: string[] = [];
  let remainingBytes = budget * 3;
  const append = (path: string, text: string, truncated: boolean) => {
    const heading = `\n--- ${path} ---\n`;
    const room = remainingBytes - Buffer.byteLength(heading);
    const body = prefix(text, room);
    const omitted = truncated || body !== text;
    if (body) {
      sections.push(heading + body);
      remainingBytes -= Buffer.byteLength(heading + body);
      memory.sources.push({ path, revision: revision(text), truncated: omitted });
    }
    if (omitted) memory.diagnostics.push(`${path}: instructions truncated by the memory budget.`);
  };
  if (options.userInstructions) append("User instructions", options.userInstructions, false);
  for (const path of SOURCE_PATHS) {
    try {
      const content = await readBounded(root, path);
      append(path, content.text, content.truncated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        memory.diagnostics.push(
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }
  memory.text = sections.join("");
  return memory;
}

/** Permission enforcement remains in the shared executor; these tools declare read/write kinds. */
export function createMemoryTools(): ToolDefinition[] {
  return [
    {
      name: "memory_read",
      description:
        "Read persistent project memory and its revision before updating it. Root AGENTS.md and CLAUDE.md are loaded automatically each run.",
      kind: "read",
      inputSchema: objectSchema({}, []),
      async execute(_args, context) {
        context.signal.throwIfAborted();
        try {
          const content = await readBounded(context.root, MEMORY_PATH);
          return {
            text: `Revision: ${content.truncated ? "unavailable (file too large; shorten it locally before updating)" : revision(content.text)}\n${content.text || "Project memory is empty."}`,
            details: {
              path: MEMORY_PATH,
              revision: content.truncated ? null : revision(content.text),
              truncated: content.truncated,
            },
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return {
            text: "No project memory yet. Revision: null",
            details: { path: MEMORY_PATH, revision: null },
          };
        }
      },
    },
    {
      name: "memory_write",
      description:
        "Save concise durable project conventions and decisions in .vcli/MEMORY.md. Supply the revision from memory_read, or null only when creating the file. Never store credentials.",
      kind: "write",
      inputSchema: objectSchema(
        { text: stringSchema, expectedRevision: { type: ["string", "null"] } },
        ["text", "expectedRevision"],
      ),
      async execute(args, context) {
        const text = String(args.text);
        if (estimateTokens(text) > 4_000)
          throw new Error(
            "Project memory is limited to 4000 estimated tokens; keep durable notes concise.",
          );
        context.signal.throwIfAborted();
        using filesystem = new RootedFileSystem(context.root, { allowProtectedPaths: true });
        let current: string | undefined;
        try {
          const content = await readBounded(context.root, MEMORY_PATH);
          if (content.truncated)
            throw new Error("Project memory is too large; shorten it locally before updating.");
          current = content.text;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if ((current === undefined ? null : revision(current)) !== args.expectedRevision)
          throw new Error("Project memory changed; read it again before writing.");
        const before = filesystem.snapshot(MEMORY_PATH, MAX_FILE_BYTES);
        if ((before?.digest ?? null) !== args.expectedRevision)
          throw new Error("Project memory changed; read it again before writing.");
        context.signal.throwIfAborted();
        filesystem.writeAtomic(MEMORY_PATH, text, { expected: before ?? null, mode: 0o600 });
        return {
          text: "Saved project memory; it will be reloaded on the next run.",
          changedPaths: [MEMORY_PATH],
          details: { revision: revision(text) },
        };
      },
    },
  ];
}
