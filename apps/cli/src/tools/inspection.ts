import { boundText, type ToolDefinition } from "@vcli/core";
import { executeProcess } from "./process.ts";
import { objectSchema, stringSchema } from "./schema.ts";

/** Local navigation and review never require another model call. */
export const inspectionTools: ToolDefinition[] = [
  {
    name: "files_list",
    description: "List unignored project files, optionally matching a ripgrep glob.",
    kind: "read",
    eager: false,
    inputSchema: objectSchema({ glob: stringSchema }, []),
    async execute(args, context) {
      const result = await executeProcess(
        "rg",
        [
          "--files",
          "--hidden",
          "--glob",
          "!.git/**",
          "--glob",
          "!.vcli/state/**",
          "--glob",
          "!.vcli/artifacts/**",
          ...(args.glob ? ["--glob", String(args.glob)] : []),
          ".",
        ],
        context,
        20_000,
      );
      return {
        text: boundText(result.output || "No matching files.", 3000),
        fullOutput: result.output,
        isError: result.code > 1,
      };
    },
  },
  {
    name: "git_diff",
    description: "Review project changes without external diff programs or text conversion.",
    kind: "read",
    eager: false,
    inputSchema: objectSchema({ staged: { type: "boolean" }, path: stringSchema }, []),
    async execute(args, context) {
      const result = await executeProcess(
        "git",
        [
          "--no-pager",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...(args.staged ? ["--cached"] : []),
          "--",
          ...(args.path ? [String(args.path)] : []),
        ],
        context,
        20_000,
      );
      return {
        text: boundText(result.output || "No changes.", 3000),
        fullOutput: result.output,
        isError: result.code !== 0,
      };
    },
  },
];
