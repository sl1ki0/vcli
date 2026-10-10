import { spawn } from "node:child_process";
import type { ToolContext } from "@vcli/core";

const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 500;

export async function executeProcess(
  command: string,
  args: string[],
  context: ToolContext,
  timeoutMs = 120_000,
): Promise<{ code: number; output: string }> {
  context.signal.throwIfAborted();

  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: context.root,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

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
      if (!killTimer) {
        killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      }
    };

    const collect = (chunk: Buffer) => {
      const room = OUTPUT_LIMIT_BYTES - bytes;
      if (room > 0) {
        const part = chunk.subarray(0, room);
        chunks.push(part);
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
      clearTimeout(killTimer);
      context.signal.removeEventListener("abort", abort);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    context.signal.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("close", (code) => {
      cleanup();
      if (context.signal.aborted) {
        reject(context.signal.reason ?? new Error("Aborted"));
        return;
      }

      const suffix = capped
        ? "\nOutput exceeded 32 MiB; process terminated."
        : timedOut
          ? "\nProcess timed out and was terminated."
          : "";
      accept({
        code: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8") + suffix,
      });
    });
  });
}
