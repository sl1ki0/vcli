import { boundText, type ToolDefinition } from "@vcli/core";
import { authorizeFilePath } from "./files.ts";
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
      const paths: string[] = [];
      for (const path of result.output.split("\n").filter(Boolean)) {
        try {
          await authorizeFilePath(context, path);
          paths.push(path);
        } catch {
          /* Do not expose denied paths from the project listing. */
        }
      }
      const output = paths.join("\n");
      return {
        text: boundText(output || "No matching files.", 3000),
        fullOutput: output,
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
      if (args.path) await authorizeFilePath(context, args.path as string, false, true);
      let scope = args.path ? [args.path as string] : [];
      if (context.authorizePath) {
        // Enumerate every requested scope; allowing a directory never allows its denied children.
        const listed = await executeProcess(
          "git",
          [
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            ...(args.staged ? ["--cached"] : []),
            "--",
            ...scope,
          ],
          context,
          20_000,
        );
        if (listed.code !== 0) return { text: listed.output, isError: true };
        scope = [];
        for (const path of listed.stdout.split("\0").filter(Boolean)) {
          try {
            await authorizeFilePath(context, path);
            scope.push(path);
          } catch {
            /* Do not open or expose denied source through Git diff. */
          }
        }
        if (!scope.length) return { text: "No changes in allowed paths.", fullOutput: "" };
      }
      const result = await executeProcess(
        "git",
        [
          "--no-pager",
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...(args.staged ? ["--cached"] : []),
          "--",
          ...scope,
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
