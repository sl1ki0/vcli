import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  ToolRegistry,
  type ManagedExecutor,
  type RunResult,
  type ToolCall,
  type ToolSchema,
} from "@vcli/core";
import { HomeworkPolicy } from "./policy.ts";

const string = { type: "string", minLength: 1, maxLength: 4096 };
const fields = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const schemas: ToolSchema[] = [
  {
    name: "list_files",
    description: "List immediate allowed workspace files and directories using a relative path.",
    inputSchema: fields({ path: string }),
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file inside allowed workspace directories.",
    inputSchema: fields({ path: string }),
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 workspace file. Existing file mode is preserved.",
    inputSchema: fields({ path: string, content: { type: "string", maxLength: 1_048_576 } }),
  },
  {
    name: "delete_file",
    description: "Delete one regular workspace file, always requiring explicit approval.",
    inputSchema: fields({ path: string }),
  },
  {
    name: "Bash",
    description:
      "Run an exact policy-allowed simple command through Bash in a relative workspace cwd. Returns stdout, stderr and exitCode. Shell syntax and path arguments are forbidden.",
    inputSchema: fields({ command: string, cwd: string }),
  },
];

/** Bound the bytes actually charged to the run, including JSON overhead. */
function bounded(result: RunResult, limit: number): RunResult {
  const bytes = Buffer.from(result.text);
  if (bytes.length <= limit) return result;
  let text = bytes.subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(text) > limit) text = text.slice(0, -1);
  return { ...result, text, truncated: true };
}

export class HomeworkExecutor implements ManagedExecutor {
  readonly schemas = structuredClone(schemas);
  private readonly registry = new ToolRegistry();

  constructor(readonly policy: HomeworkPolicy) {
    for (const schema of this.schemas)
      this.registry.register({
        ...schema,
        kind: "read",
        execute: async () => ({ text: "" }),
      });
  }

  validate(call: ToolCall): void {
    this.registry.validate(call);
  }

  kind(name: string): "read" | "write" | "delete" | "bash" | "control" {
    if (name === "write_file") return "write";
    if (name === "delete_file") return "delete";
    if (name === "Bash") return "bash";
    if (name === "read_file" || name === "list_files") return "read";
    return "control";
  }

  async check(call: ToolCall): Promise<void> {
    this.validate(call);
    if (call.name === "Bash") {
      this.policy.command(call.arguments.command as string);
      await this.policy.path(call.arguments.cwd as string, "directory");
    } else {
      const path = await this.policy.path(
        call.arguments.path as string,
        call.name === "list_files" ? "directory" : "file",
      );
      if (call.name === "write_file")
        await this.policy.path(relative(this.policy.root, dirname(path)) || ".", "directory");
    }
  }

  async execute(call: ToolCall, resultBytes: number, signal: AbortSignal): Promise<RunResult> {
    if (!Number.isSafeInteger(resultBytes) || resultBytes < 0)
      throw new Error("Result budget must be a nonnegative integer.");
    await this.check(call);
    signal.throwIfAborted();
    const limit = Math.min(resultBytes, this.policy.maxOutputBytes);
    try {
      let result: RunResult;
      if (call.name === "Bash") result = await this.bash(call, limit, signal);
      else if (call.name === "list_files")
        result = await this.list(call.arguments.path as string, limit);
      else if (call.name === "read_file")
        result = await this.read(call.arguments.path as string, limit);
      else if (call.name === "write_file") {
        await this.write(call.arguments.path as string, call.arguments.content as string);
        result = { text: `Wrote ${call.arguments.path}` };
      } else {
        const path = await this.policy.path(call.arguments.path as string, "file");
        await unlink(path);
        result = { text: `Deleted ${call.arguments.path}` };
      }
      return bounded(result, limit);
    } catch (error) {
      return bounded(
        { text: error instanceof Error ? error.message : String(error), isError: true },
        limit,
      );
    }
  }

  private async list(value: string, limit: number): Promise<RunResult> {
    const directory = await opendir(await this.policy.path(value, "directory"));
    const entries: string[] = [];
    let bytes = 0;
    let truncated = false;
    for await (const entry of directory) {
      const child = value === "." ? entry.name : `${value}/${entry.name}`;
      try {
        await this.policy.path(child);
      } catch {
        continue;
      }
      const text = `${entry.name}${entry.isDirectory() ? "/" : ""}`;
      const size = Buffer.byteLength(text) + 1;
      if (bytes + size > limit) {
        truncated = true;
        break;
      }
      entries.push(text);
      bytes += size;
    }
    return { text: entries.sort().join("\n"), truncated };
  }

  private async read(value: string, limit: number): Promise<RunResult> {
    const path = await this.policy.path(value, "file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Read requires a single-link regular file.");
      await this.policy.path(value, "file");
      const current = await lstat(path);
      if (stat.ino !== current.ino || stat.dev !== current.dev)
        throw new Error("File changed while opening for read.");
      const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      return {
        text: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
        truncated: bytesRead > limit || stat.size > limit,
      };
    } finally {
      await handle.close();
    }
  }

  private async write(value: string, content: string): Promise<void> {
    const path = await this.policy.path(value, "file");
    let exists = false;
    try {
      await lstat(path);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (exists ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o644,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Write requires a single-link regular file.");
      await this.policy.path(value, "file");
      const current = await lstat(path);
      if (stat.ino !== current.ino || stat.dev !== current.dev)
        throw new Error("File changed while opening for write.");
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async bash(call: ToolCall, limit: number, signal: AbortSignal): Promise<RunResult> {
    const command = call.arguments.command as string;
    const cwd = await this.policy.path(call.arguments.cwd as string, "directory");
    this.policy.command(command);
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd,
        // No credentials, startup hooks, exported functions, PYTHONPATH or current-directory PATH.
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let failure: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          // The process group may have already exited.
        }
      };
      const stop = (reason: string) => {
        failure ??= reason;
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 100);
      };
      const abort = () => stop("Bash cancelled");
      const timer = setTimeout(() => stop("Bash timeout"), this.policy.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const collect = (target: Buffer[], chunk: Buffer) => {
        const room = Math.max(0, limit - bytes);
        if (room) {
          const part = chunk.subarray(0, room);
          target.push(Buffer.from(part));
          bytes += part.length;
        }
        if (chunk.length > room) {
          truncated = true;
          stop("Bash output limit");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        failure = error.message;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        // Reap any descendants left in this process group, even if Bash exited first.
        kill("SIGKILL");
        let out = Buffer.concat(stdout).toString("utf8");
        let err = Buffer.concat(stderr).toString("utf8");
        const payload = () =>
          JSON.stringify({ stdout: out, stderr: err, exitCode: code, error: failure });
        let text = payload();
        while (Buffer.byteLength(text) > limit && (out.length || err.length)) {
          truncated = true;
          if (out.length >= err.length)
            out = out.slice(
              0,
              Math.max(
                0,
                out.length - Math.max(1, Math.ceil((Buffer.byteLength(text) - limit) / 2)),
              ),
            );
          else
            err = err.slice(
              0,
              Math.max(
                0,
                err.length - Math.max(1, Math.ceil((Buffer.byteLength(text) - limit) / 2)),
              ),
            );
          text = payload();
        }
        resolve({ text, exitCode: code ?? -1, isError: Boolean(failure) || code !== 0, truncated });
      });
    });
  }
}
