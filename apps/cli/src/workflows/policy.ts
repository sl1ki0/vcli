import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolCall, ToolContext } from "@vcli/core";
import { RootedFileSystem } from "./rooted-filesystem.ts";
import { privateProjectPath } from "./private-path.ts";

interface Rules {
  allow: string[];
  deny: string[];
}
interface PolicyDocument {
  version: 1;
  commands: Rules;
  directories: Rules;
}
export interface PathOptions {
  directory?: boolean;
  allowRoot?: boolean;
  write?: boolean;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
export function pathInside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** All local file tools use this guard, including when no restrictive policy is configured. */
export async function projectPath(
  rootInput: string,
  input: string,
  options: PathOptions = {},
): Promise<string> {
  if (!input || input.includes("\0") || input.split(/[\\/]/).includes(".."))
    throw new Error("Project paths must not contain parent traversal or NUL bytes.");
  const launchRoot = resolve(rootInput);
  const root = await realpath(launchRoot);
  const requested = resolve(launchRoot, input);
  const path = pathInside(launchRoot, requested)
    ? resolve(root, relative(launchRoot, requested))
    : requested;
  if (!pathInside(root, path) || (!options.allowRoot && path === root))
    throw new Error("Path must remain inside the project workspace.");
  const protectedPath = (candidate: string): boolean => {
    return privateProjectPath(relative(root, candidate));
  };
  if (protectedPath(path))
    throw new Error("Agent tools cannot access protected project configuration or state.");
  const components = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index++) {
    const candidate = join(current, components[index]!);
    const final = index === components.length - 1;
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error("Project paths cannot contain symbolic links.");
      if (!final && !stat.isDirectory()) throw new Error("Path parent is not a directory.");
      if (final && options.directory && !stat.isDirectory())
        throw new Error("Working directory must be an existing directory.");
      if (final && !stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))
        throw new Error("Project tools require regular files without hard links.");
      // Real paths also normalize filesystem casing. Lexical casing alone is not an
      // authorization identity on the default macOS/Windows filesystems.
      current = await realpath(candidate);
      if (!pathInside(root, current))
        throw new Error("Path must remain inside the project workspace.");
      if (protectedPath(current))
        throw new Error("Agent tools cannot access protected project configuration or state.");
    } catch (error) {
      if (!missing(error)) throw error;
      if (options.directory) throw new Error("Working directory does not exist.");
      return join(current, ...components.slice(index));
    }
  }
  return current;
}

function rules(value: unknown, name: string): Rules {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Policy ${name} must contain allow and deny arrays.`);
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "allow" && key !== "deny"))
    throw new Error(`Unknown policy ${name} field.`);
  for (const key of ["allow", "deny"]) {
    if (
      !Array.isArray(fields[key]) ||
      (fields[key] as unknown[]).some((entry) => typeof entry !== "string" || !entry.length)
    )
      throw new Error(`Policy ${name}.${key} must be an array of nonempty strings.`);
  }
  return fields as unknown as Rules;
}

/** Parse a deliberately small Bash subset. Exact authorization never delegates nested syntax. */
export function simpleCommand(command: string): string[] {
  if (!command.trim() || command.length > 16_384 || /[\n\r\0$`|&;<>()[\]{}*?~\\]/.test(command))
    throw new Error(
      "Strict policy permits exact simple commands without shell expansion or operators.",
    );
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let present = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      present = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      present = true;
    } else if (/\s/.test(char)) {
      if (present) tokens.push(token);
      token = "";
      present = false;
    } else {
      token += char;
      present = true;
    }
  }
  if (quote) throw new Error("Unterminated command quote.");
  if (present) tokens.push(token);
  if (!tokens.length || tokens[0]!.includes("="))
    throw new Error("Command assignments are forbidden.");
  const program = tokens[0]!.split("/").at(-1)!;
  if (
    /^(?:ba|da|z|fi|k|tc|c)?sh$/.test(program) ||
    [
      "env",
      "eval",
      "exec",
      "command",
      "source",
      ".",
      "xargs",
      "find",
      "sudo",
      "su",
      "doas",
      "chroot",
      "nsenter",
      "nice",
      "nohup",
      "timeout",
      "watch",
      "parallel",
      "ssh",
    ].includes(program)
  )
    throw new Error("Nested command execution is forbidden by strict policy.");
  if (
    tokens
      .slice(1)
      .some((token) =>
        /^(?:-[a-zA-Z]*[cep][a-zA-Z]*(?:=|$)|--(?:eval|exec|command|print|require|import)(?:=|$))/.test(
          token,
        ),
      ) &&
    /^(?:python[\d.]*|ruby|perl|node|bun|deno|php|lua)$/.test(program)
  )
    throw new Error("Interpreter code arguments are forbidden by strict policy.");
  return tokens;
}

export class ProjectPolicy {
  private constructor(
    readonly root: string,
    readonly policyPath: string | undefined,
    private readonly document?: PolicyDocument,
  ) {}

  get strict(): boolean {
    return Boolean(this.document);
  }

  static async load(
    rootInput: string,
    policyPath?: string,
    options: { stateDirectory?: string } = {},
  ): Promise<ProjectPolicy> {
    const root = await realpath(rootInput);
    if (options.stateDirectory) {
      const parts: string[] = [];
      let parent = resolve(options.stateDirectory);
      let canonicalState: string;
      while (true) {
        try {
          canonicalState = join(await realpath(parent), ...parts);
          break;
        } catch (error) {
          if (!missing(error)) throw error;
          parts.unshift(basename(parent));
          parent = dirname(parent);
        }
      }
      if (pathInside(root, canonicalState))
        throw new Error("Run state must be outside the mutable workspace.");
    }
    if (!policyPath) return new ProjectPolicy(root, undefined);
    const path = resolve(policyPath);
    const canonical = await realpath(path);
    if (pathInside(root, canonical))
      throw new Error("Policy must be outside the mutable workspace.");
    if (canonical !== path)
      throw new Error("Policy path must be canonical without symbolic links.");
    const filesystem = new RootedFileSystem("/", {
      canonicalRoot: true,
      allowProtectedPaths: true,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(filesystem.readText(path, 65_536));
    } finally {
      filesystem.close();
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid policy document.");
    const value = raw as Record<string, unknown>;
    if (
      value.version !== 1 ||
      Object.keys(value).some((key) => !["version", "commands", "directories"].includes(key))
    )
      throw new Error("Policy version must be 1 and fields must be recognized.");
    const document: PolicyDocument = {
      version: 1,
      commands: rules(value.commands, "commands"),
      directories: rules(value.directories, "directories"),
    };
    for (const command of [...document.commands.allow, ...document.commands.deny])
      simpleCommand(command);
    for (const kind of ["allow", "deny"] as const) {
      document.directories[kind] = await Promise.all(
        document.directories[kind].map(async (directory) => {
          const checked = await projectPath(root, directory, { allowRoot: true, directory: true });
          if (isAbsolute(directory) && checked !== directory)
            throw new Error("Absolute policy directories must be canonical paths.");
          return checked;
        }),
      );
    }
    return new ProjectPolicy(root, canonical, document);
  }

  async resolvePath(input: string, options: PathOptions = {}): Promise<string> {
    const path = await projectPath(this.root, input, options);
    if (this.document) {
      const directories = this.document.directories;
      if (
        directories.deny.some((directory) => pathInside(directory, path)) ||
        !directories.allow.some((directory) => pathInside(directory, path))
      )
        throw new Error("Directory is denied or not explicitly allowed by policy.");
    }
    return path;
  }

  async canTraverseDirectory(input: string): Promise<boolean> {
    const path = await projectPath(this.root, input, { directory: true, allowRoot: true });
    if (!this.document) return true;
    const directories = this.document.directories;
    return (
      !directories.deny.some((directory) => pathInside(directory, path)) &&
      directories.allow.some(
        (directory) => pathInside(directory, path) || pathInside(path, directory),
      )
    );
  }

  async assertCommand(command: string, cwd = "."): Promise<string> {
    const directory = await this.resolvePath(cwd, { allowRoot: true, directory: true });
    if (!this.document) return directory;
    const argv = simpleCommand(command);
    if (argv[0]!.includes("/") && (!isAbsolute(argv[0]!) || pathInside(this.root, argv[0]!)))
      await this.resolvePath(resolve(directory, argv[0]!));
    const commands = this.document.commands;
    if (commands.deny.includes(command) || !commands.allow.includes(command))
      throw new Error("Command is denied or not explicitly allowed by policy.");
    for (const arg of argv.slice(1)) {
      const value =
        arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (arg.startsWith("-") && !arg.includes("=") && /[\\/]/.test(arg))
        throw new Error("Combined option/path arguments are forbidden by strict policy.");
      if (!value.startsWith("-")) {
        if (value.split(/[\\/]/).includes(".."))
          throw new Error("Command path traversal is forbidden.");
        await this.resolvePath(resolve(directory, value), { allowRoot: true });
      }
    }
    return directory;
  }

  requiresApproval(call: ToolCall): boolean {
    if (!this.strict) return false;
    if (call.name === "files_delete") return true;
    return (
      call.name === "shell_run" &&
      ["rm", "rmdir", "unlink"].includes(
        simpleCommand(call.arguments.command as string)[0]!
          .split("/")
          .at(-1)!,
      )
    );
  }

  async assertTool(call: ToolCall, context: ToolContext): Promise<void> {
    context.signal.throwIfAborted();
    if (call.name === "shell_run") {
      await this.assertCommand(
        call.arguments.command as string,
        call.arguments.cwd as string | undefined,
      );
      return;
    }
    if (call.name.startsWith("files_") || call.name === "git_diff")
      await this.resolvePath((call.arguments.path as string | undefined) ?? ".", {
        allowRoot:
          call.name !== "files_patch" && call.name !== "files_read" && call.name !== "files_delete",
      });
    if (this.strict && (call.name.startsWith("mcp.") || call.name.startsWith("mcp_")))
      throw new Error("Strict project policy does not authorize external process or MCP effects.");
  }
}
