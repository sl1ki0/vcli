import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface HomeworkPolicyConfig {
  version: 1;
  commands: { allow: string[]; deny: string[] };
  directories: { allow: string[]; deny: string[] };
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function inside(root: string, value: string): boolean {
  const part = relative(root, value);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

function localPath(value: string): void {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  )
    throw new Error("Policy requires a relative workspace path without '..' or links.");
}

/** Check every existing component, including ancestors of the workspace itself. */
async function noLinks(value: string): Promise<void> {
  const parts = resolve(value).split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new Error(`Policy rejects symbolic links and hard links: ${current}`);
      if (!stat.isDirectory() && current !== resolve(value))
        throw new Error(`Path ancestor is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function parseConfig(raw: unknown): HomeworkPolicyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid homework policy object.");
  const config = raw as Record<string, unknown>;
  if (
    config.version !== 1 ||
    Object.keys(config).some(
      (key) => !["version", "commands", "directories", "timeoutMs", "maxOutputBytes"].includes(key),
    )
  )
    throw new Error("Homework policy requires version: 1 and recognized fields.");
  for (const key of ["commands", "directories"]) {
    const rules = config[key];
    if (!rules || typeof rules !== "object" || Array.isArray(rules))
      throw new Error(`Policy ${key} requires allow and deny arrays.`);
    const fields = rules as Record<string, unknown>;
    if (Object.keys(fields).some((name) => !["allow", "deny"].includes(name)))
      throw new Error(`Unknown policy ${key} field.`);
    for (const name of ["allow", "deny"])
      if (
        !Array.isArray(fields[name]) ||
        (fields[name] as unknown[]).some((value) => typeof value !== "string" || !value)
      )
        throw new Error(`Policy ${key}.${name} requires nonempty strings.`);
  }
  for (const key of ["timeoutMs", "maxOutputBytes"])
    if (
      config[key] !== undefined &&
      (!Number.isSafeInteger(config[key]) ||
        Number(config[key]) < 1 ||
        Number(config[key]) > 16_777_216)
    )
      throw new Error(`Policy ${key} must be a positive bounded integer.`);
  return structuredClone(config) as unknown as HomeworkPolicyConfig;
}

/** Deliberately supports only exact, simple commands without filesystem arguments. */
function simpleCommand(command: string): void {
  if (command.length > 4096 || !/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/.test(command))
    throw new Error("Policy rejects shell syntax, paths, substitutions and non-simple commands.");
  const [program, ...args] = command.split(" ");
  if (
    /^(?:ba|da|z|k|c|fi)?sh$/.test(program!) ||
    ["env", "eval", "exec", "command", "source", "sudo", "su", "xargs"].includes(program!) ||
    (/^(?:python\d*|node|bun|deno|ruby|perl|php)$/.test(program!) &&
      args.some((arg) => /^-(?:[A-Za-z]*[ce]|[A-Za-z]*eval)/.test(arg) || arg === "--eval"))
  )
    throw new Error("Policy rejects nested shells and inline interpreter commands.");
  // Generic bare arguments can still denote paths (for example `rm private`).
  // Keep filesystem/program semantics explicit instead of guessing from token spelling.
  if (
    !/^python3? -m unittest(?: -v)?$/.test(command) &&
    !/^echo(?: [A-Za-z0-9_-]+)*$/.test(command) &&
    !/^sleep [0-9]+$/.test(command) &&
    command !== "yes" &&
    command !== "true" &&
    command !== "false"
  )
    throw new Error(
      "Policy supports only unittest, echo, sleep, yes, true and false commands without path arguments.",
    );
}

export class HomeworkPolicy {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  private constructor(
    readonly root: string,
    readonly policyPath: string,
    private readonly config: HomeworkPolicyConfig,
    private readonly allow: string[],
    private readonly deny: string[],
  ) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 65_536;
  }

  static async open(root: string, policyPath: string): Promise<HomeworkPolicy> {
    const absoluteRoot = resolve(root);
    await noLinks(absoluteRoot);
    if (!(await lstat(absoluteRoot)).isDirectory())
      throw new Error("Workspace must be a directory.");
    const canonicalRoot = await realpath(absoluteRoot);
    const absolutePolicy = resolve(policyPath);
    await noLinks(absolutePolicy);
    if (inside(canonicalRoot, absolutePolicy))
      throw new Error("Homework policy must be outside the mutable workspace.");
    const policyStat = await lstat(absolutePolicy);
    if (!policyStat.isFile() || policyStat.size > 65_536)
      throw new Error("Policy must be a regular file of at most 64 KiB.");
    const canonicalPolicy = await realpath(absolutePolicy);
    const config = parseConfig(JSON.parse(await readFile(canonicalPolicy, "utf8")));
    const paths = async (values: string[]) => {
      const result: string[] = [];
      for (const value of values) {
        localPath(value);
        const path = resolve(canonicalRoot, value);
        if (!inside(canonicalRoot, path))
          throw new Error("Policy directories must be inside workspace.");
        await noLinks(path);
        try {
          if (!(await lstat(path)).isDirectory())
            throw new Error("Policy path must be a directory.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        result.push(path);
      }
      return result;
    };
    return new HomeworkPolicy(
      canonicalRoot,
      canonicalPolicy,
      config,
      await paths(config.directories.allow),
      await paths(config.directories.deny),
    );
  }

  async path(value: string, kind?: "file" | "directory"): Promise<string> {
    localPath(value);
    const path = resolve(this.root, value);
    if (
      !inside(this.root, path) ||
      this.deny.some((directory) => inside(directory, path)) ||
      !this.allow.some((directory) => inside(directory, path))
    )
      throw new Error(`Policy denies workspace path: ${value}`);
    await noLinks(path);
    try {
      const stat = await lstat(path);
      if (kind === "file" && !stat.isFile()) throw new Error(`Expected regular file: ${value}`);
      if (kind === "directory" && !stat.isDirectory())
        throw new Error(`Expected directory: ${value}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (kind === "directory") throw error;
    }
    return path;
  }

  command(command: string): void {
    simpleCommand(command);
    if (
      this.config.commands.deny.includes(command) ||
      !this.config.commands.allow.includes(command)
    )
      throw new Error(`Policy denies Bash command: ${command}`);
  }
}
