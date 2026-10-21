import { spawn } from "node:child_process";
import type { ToolContext } from "@vcli/core";
import { projectPath } from "./policy.ts";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { pathInside } from "./policy.ts";
import { createSandboxWorkspace } from "./sandbox-workspace.ts";
import { prepareSandbox } from "./process-sandbox.ts";

const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 500;

export async function executeProcess(
  command: string,
  args: string[],
  context: ToolContext,
  timeoutMs = 120_000,
  options: {
    cwd?: string;
    outputLimitBytes?: number;
    access?: "read" | "write";
    allowGitRead?: boolean;
    stdin?: string | ((root: string) => string);
  } = {},
): Promise<{
  code: number;
  output: string;
  stdout: string;
  stderr: string;
  cwd: string;
  truncated: boolean;
  timedOut: boolean;
}> {
  context.signal.throwIfAborted();
  const cwd = await projectPath(context.root, options.cwd ?? ".", {
    directory: true,
    allowRoot: true,
  });
  // Canonicalization is asynchronous; cancellation may arrive while it is in progress.
  context.signal.throwIfAborted();
  const limit = Math.max(
    0,
    Math.min(
      OUTPUT_LIMIT_BYTES,
      options.outputLimitBytes ?? OUTPUT_LIMIT_BYTES,
      context.resultBytes ?? OUTPUT_LIMIT_BYTES,
    ),
  );

  const canonicalRoot = await realpath(context.root);
  const roots = [...new Set([context.root, canonicalRoot])];
  const access = options.access ?? "write";
  const workspace = await createSandboxWorkspace({
    root: context.root,
    access,
    allowGitRead: options.allowGitRead,
    authorizePath: context.authorizePath,
  });
  let prepared: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
  try {
    const mapArgument = (argument: string): string => {
      if (isAbsolute(argument) && roots.some((root) => pathInside(root, argument)))
        return workspace.mapPath(argument);
      if (roots.some((root) => argument.includes(root)))
        throw new Error(
          "Use relative workspace paths inside shell commands; absolute original workspace paths are outside system isolation.",
        );
      return argument;
    };
    prepared = await prepareSandbox({
      root: workspace.root,
      originalRoot: workspace.originalRoot,
      cwd: workspace.cwd(cwd),
      command:
        isAbsolute(command) && roots.some((root) => pathInside(root, command))
          ? workspace.mapPath(command)
          : command,
      args: args.map(mapArgument),
      access,
      allowGitRead: options.allowGitRead,
      signal: context.signal,
      staged: true,
    });
    const input =
      typeof options.stdin === "function" ? options.stdin(workspace.root) : options.stdin;
    if (input !== undefined && Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Process input exceeds its 1 MiB limit.");
    context.signal.throwIfAborted();
    const launch = prepared;
    const result = await new Promise<{
      code: number;
      output: string;
      stdout: string;
      stderr: string;
      cwd: string;
      truncated: boolean;
      timedOut: boolean;
    }>((accept, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: process.platform !== "win32",
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe", ...launch.stdioFds],
      });
      const chunks: Buffer[] = [];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let capped = false;
      let timedOut = false;
      let termination: Promise<void> | undefined;

      const kill = (signal: NodeJS.Signals) => {
        // Both supported wrappers contain and drain their descendants before
        // exiting. A reaped numeric process group may already belong to another run.
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          // Stop the entire process group, including shell children, on POSIX.
          if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The process may have already exited.
        }
      };

      const stop = () => {
        kill("SIGTERM");
        // Escalate only while the trusted containment wrapper is still alive.
        termination ??= new Promise((resolve) => {
          setTimeout(() => {
            kill("SIGKILL");
            resolve();
          }, KILL_GRACE_MS);
        });
      };

      const collect = (chunk: Buffer, stream: Buffer[]) => {
        const room = limit - bytes;
        if (room > 0) {
          const part = chunk.subarray(0, room);
          chunks.push(part);
          stream.push(part);
          bytes += part.length;
        }
        if (chunk.length > room) {
          capped = true;
          stop();
        }
      };

      const abort = () => stop();
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      };

      child.stdout!.on("data", (chunk: Buffer) => collect(chunk, stdout));
      child.stderr!.on("data", (chunk: Buffer) => collect(chunk, stderr));
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();

      if (child.stdin) {
        // Hooks may close stdin without consuming the complete payload.
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }

      child.once("error", (error) => {
        cleanup();
        reject(error);
      });

      child.once("close", async (code) => {
        await termination;
        cleanup();
        if (context.signal.aborted) {
          reject(context.signal.reason ?? new Error("Aborted"));
          return;
        }

        const suffix = capped
          ? `\nOutput exceeded ${limit} bytes; process terminated.`
          : timedOut
            ? "\nProcess timed out and was terminated."
            : "";
        accept({
          code: code ?? 1,
          output: Buffer.concat(chunks).toString("utf8") + suffix,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          cwd,
          truncated: capped,
          timedOut,
        });
      });
    });
    // A failed command can still have produced real edits. Import its observed output
    // once, after every descendant is drained. Cancellation discards the staged tree.
    context.signal.throwIfAborted();
    if (result.code === 125) {
      const discarded =
        "\nSystem isolation could not confirm a clean command completion; staged changes were discarded (reserved exit 125).";
      result.output += discarded;
      result.stderr += discarded;
    } else await workspace.commit();
    const present = (value: string) => value.replaceAll(workspace.root, canonicalRoot);
    return {
      ...result,
      output: present(result.output),
      stdout: present(result.stdout),
      stderr: present(result.stderr),
    };
  } finally {
    try {
      await prepared?.dispose();
    } finally {
      await workspace.dispose();
    }
  }
}
