import { spawn } from "node:child_process";
import type { ToolContext } from "@vcli/core";
import { projectPath } from "../workflows/policy.ts";
import { processEnvironment } from "../workflows/process-environment.ts";

const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 500;

export async function executeProcess(
  command: string,
  args: string[],
  context: ToolContext,
  timeoutMs = 120_000,
  options: { cwd?: string; outputLimitBytes?: number } = {},
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

  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: processEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    let timedOut = false;
    let backgroundTerminated = false;
    let termination: Promise<void> | undefined;

    const kill = (signal: NodeJS.Signals) => {
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
      // The group may outlive its leader after closing inherited stdio. Keep escalation
      // alive until SIGKILL has been sent, even when the leader emits close first.
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

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr));
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();

    child.once("exit", () => {
      if (!termination && child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, 0);
          backgroundTerminated = true;
          stop();
        } catch {
          /* No group remains after the leader exits. */
        }
      }
    });

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

      const background = backgroundTerminated
        ? "\nBackground subprocesses were terminated after command exit; background work is unsupported."
        : "";
      const suffix = capped
        ? `\nOutput exceeded ${limit} bytes; process terminated.`
        : timedOut
          ? "\nProcess timed out and was terminated."
          : "";
      accept({
        code: backgroundTerminated && code === 0 ? 1 : (code ?? 1),
        output: Buffer.concat(chunks).toString("utf8") + suffix + background,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + background,
        cwd,
        truncated: capped,
        timedOut,
      });
    });
  });
}
