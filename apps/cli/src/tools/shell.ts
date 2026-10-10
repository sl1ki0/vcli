import { boundText, type ToolDefinition } from "@vcli/core";
import { executeProcess } from "./process.ts";
import { objectSchema, stringSchema } from "./schema.ts";

export const shellTool: ToolDefinition = {
  name: "shell_run",
  description:
    "Run a shell command for builds, tests, Git, or other tasks. This can have arbitrary side effects. Uses the active permission mode.",
  kind: "execute",
  inputSchema: objectSchema(
    {
      command: stringSchema,
      timeoutMs: { type: "integer", minimum: 100, maximum: 600_000 },
    },
    ["command"],
  ),
  async execute(args, context) {
    const result = await executeProcess(
      process.env.SHELL ?? "/bin/sh",
      ["-c", String(args.command)],
      context,
      Number(args.timeoutMs ?? 120_000),
    );
    const full = `Exit ${result.code}\n${result.output}`;
    return {
      text: boundText(full, 3_000),
      fullOutput: full,
      isError: result.code !== 0,
    };
  },
};
