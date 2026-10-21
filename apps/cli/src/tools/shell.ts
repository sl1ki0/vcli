import { boundText, type ToolDefinition } from "@vcli/core";
import { executeProcess } from "./process.ts";
import { objectSchema, stringSchema } from "./schema.ts";

export const shellTool: ToolDefinition = {
  name: "shell_run",
  description:
    "Run Bash in an offline source snapshot with explicit permissions and policy. Use relative project paths. Private files, Git metadata, dependency downloads and background work are unavailable. Changes import after conflict checks. Returns stdout, stderr and exit code. On macOS nested posix_spawn is unavailable.",
  kind: "execute",
  inputSchema: objectSchema(
    {
      command: stringSchema,
      cwd: stringSchema,
      timeoutMs: { type: "integer", minimum: 100, maximum: 600_000 },
      maxOutputBytes: { type: "integer", minimum: 1, maximum: 33_554_432 },
    },
    ["command"],
  ),
  async execute(args, context) {
    const result = await executeProcess(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", args.command as string],
      context,
      (args.timeoutMs as number | undefined) ?? 120_000,
      {
        cwd: args.cwd as string | undefined,
        outputLimitBytes: args.maxOutputBytes as number | undefined,
      },
    );
    const limit = result.truncated ? "\nOutput incomplete: process output limit reached." : "";
    const timeout = result.timedOut ? "\nProcess timed out and was terminated." : "";
    const full = `Exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}${limit}${timeout}`;
    return {
      text: boundText(full, 3_000),
      fullOutput: full,
      isError: result.code !== 0,
      details: {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        cwd: result.cwd,
        truncated: result.truncated,
        timedOut: result.timedOut,
      },
    };
  },
};
