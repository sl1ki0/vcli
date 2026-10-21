import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdtemp, mkdir, realpath, readdir, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathInside } from "./policy.ts";
import { prepareProcessSupervisor } from "./process-supervisor.ts";
import {
  assertTrustedExecutable,
  directMacPython,
  trustedHostRuntimeExecutables,
} from "./trusted-executables.ts";
import { privateProjectPath } from "./private-path.ts";

export interface SandboxRequest {
  root: string;
  /** Pinned source identity: project executables cannot become trusted host runtimes. */
  originalRoot?: string;
  cwd: string;
  command: string;
  args: string[];
  /** Explicit per-server variables. Host credentials are never inherited. */
  environment?: NodeJS.ProcessEnv;
  readDirectories?: readonly string[];
  writeDirectories?: readonly string[];
  deniedPaths?: readonly string[];
  readOnlyDirectories?: readonly string[];
  access?: "read" | "write";
  allowGitRead?: boolean;
  signal?: AbortSignal;
  /** Write-capable launches require a parent-owned disposable workspace snapshot. */
  staged?: boolean;
}

export interface PreparedSandbox {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Append these descriptors after stdin/stdout/stderr when spawning. */
  stdioFds: number[];
  dispose(): Promise<void>;
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
const UNSAFE_ENVIRONMENT =
  /^(?:BASH_ENV|ENV|BASHOPTS|SHELLOPTS|BASH_FUNC_.*|DYLD_.*|LD_.*|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GIT_.*|RIPGREP_CONFIG_PATH|SSH_.*|GPG_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|HOME|PATH|TMPDIR|TMP|TEMP|XDG_.*)$/;

/** A small inherited environment prevents credentials and language startup injection. */
export function sandboxEnvironment(
  home: string,
  temporary: string,
  explicit: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: `${SYSTEM_PATH}:${dirname(process.execPath)}`,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    const value = process.env[key];
    if (value && /^[A-Za-z0-9_+./:-]{1,128}$/.test(value)) environment[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (
      !UNSAFE_ENVIRONMENT.test(key) &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      value !== undefined
    )
      environment[key] = value;
  }
  return environment;
}

function quoted(value: string): string {
  if (value.includes("\0")) throw new Error("Sandbox paths cannot contain NUL bytes.");
  return JSON.stringify(value);
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAC_SYSTEM_READ = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/usr/include",
  "/System/Library",
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/Library/Apple",
  "/Library/Developer",
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks",
  "/Library/Frameworks/Python.framework",
  "/opt/homebrew/bin",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/lib",
  "/opt/homebrew/share",
  "/usr/local/bin",
  "/usr/local/lib",
  "/usr/local/share",
];

export function macSandboxProfile(options: {
  readDirectories: readonly string[];
  writeDirectories: readonly string[];
  deniedPaths: readonly string[];
  readOnlyDirectories?: readonly string[];
  executable: string;
  runtimeExecutables?: readonly string[];
  temporary: string;
  root: string;
  allowGitRead: boolean;
}): string {
  const read = [...new Set([...MAC_SYSTEM_READ, ...options.readDirectories, options.temporary])];
  const write = [...new Set([...options.writeDirectories, options.temporary])];
  const ancestors: string[] = [];
  for (let path = dirname(options.root); path !== "/"; path = dirname(path)) ancestors.push(path);
  const filters = (paths: readonly string[]) =>
    paths.map((path) => `(subpath ${quoted(path)})`).join(" ");
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    // BSD syscall identities are shared by supported Darwin x64/arm64 ABIs.
    // posix_spawn attributes can change groups without calling setpgid/setsid.
    "(deny syscall-unix (syscall-number 26) (syscall-number 82) (syscall-number 97) (syscall-number 147) (syscall-number 244))",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(deny network* system-socket)",
    "(allow file-read-metadata)",
    // dyld reads the root directory during process initialization.
    `(allow file-read* (literal "/") ${[options.executable, ...(options.runtimeExecutables ?? [])].map((path) => `(literal ${quoted(path)})`).join(" ")} ${filters(read)})`,
    // Darwin getcwd walks ancestor directories. Literal grants permit that walk
    // without granting reads to the files or subdirectories they contain.
    ...(ancestors.length
      ? [`(allow file-read-data ${ancestors.map((path) => `(literal ${quoted(path)})`).join(" ")})`]
      : []),
    `(allow file-write* ${filters(write)})`,
    '(allow file-read-data file-write-data file-ioctl (literal "/dev/null"))',
    '(allow file-read-data file-ioctl (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
  ];
  for (const path of options.readOnlyDirectories ?? [])
    profile.push(`(deny file-write* (subpath ${quoted(path)}))`);
  // Denials are emitted last and apply to names created after sandbox startup too.
  const root = regexLiteral(options.root.replace(/\/$/, ""));
  const privateNames =
    "\\.(vcli|env[^/]*|ssh|aws|azure|gnupg|config|kube|docker|npmrc|pypirc|netrc|git-credentials)|credentials([^/]*\\.json)?|id_(rsa|dsa|ed25519|ecdsa)([._-][^/]*)?";
  const insensitive = (pattern: string) =>
    pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
  // Seatbelt uses POSIX extended regex, which has no noncapturing (?:...) groups.
  const privatePattern = `^${root}/(.*/)?(${insensitive(privateNames)})(/|$)`;
  profile.push(`(deny file-read* file-write* (regex ${quoted(privatePattern)}))`);
  const gitPattern = `^${root}/(.*/)?\\.${insensitive("git")}(/|$)`;
  profile.push(`(deny file-write* (regex ${quoted(gitPattern)}))`);
  if (!options.allowGitRead) profile.push(`(deny file-read* (regex ${quoted(gitPattern)}))`);
  for (const path of options.deniedPaths)
    profile.push(`(deny file-read* file-write* (subpath ${quoted(path)}))`);
  return profile.join("\n");
}

async function existing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function executablePath(command: string, cwd: string): Promise<string> {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : [...SYSTEM_PATH.split(":"), dirname(process.execPath)].map((directory) =>
        join(directory, command),
      );
  if (!command.includes("/")) {
    const discovered = Bun.which(command);
    if (discovered && !candidates.includes(discovered)) candidates.push(discovered);
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if (!(await lstat(path)).isFile()) continue;
      return path;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  throw new Error(`Sandbox executable is unavailable: ${command}`);
}

async function canonicalDirectories(root: string, values: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const value of values) {
    const path = await realpath(resolve(root, value));
    if (!pathInside(root, path) || !(await lstat(path)).isDirectory())
      throw new Error("Sandbox directories must remain inside the canonical workspace.");
    result.push(path);
  }
  return [...new Set(result)];
}

/** cBPF program checked by the kernel before untrusted code runs (x64/arm64 only). */
export function linuxSeccompFilter(architecture: string = process.arch): Buffer {
  const table =
    architecture === "x64"
      ? {
          audit: 0xc000003e,
          deny: [
            41, 101, 165, 166, 167, 168, 169, 175, 176, 246, 248, 249, 250, 272, 298, 303, 304, 308,
            310, 311, 313, 321, 323,
          ],
        }
      : architecture === "arm64"
        ? {
            audit: 0xc00000b7,
            deny: [
              39, 40, 97, 104, 105, 106, 117, 142, 198, 217, 218, 219, 224, 225, 241, 264, 265, 268,
              270, 271, 273, 280, 282,
            ],
          }
        : undefined;
  if (!table) throw new Error("Linux system isolation supports x64 and arm64 only.");
  const instructions: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, table.audit],
    [0x06, 0, 0, 0x80000000], // Kill ABI switches, including i386 compatibility.
    [0x20, 0, 0, 0], // seccomp_data.nr
  ];
  if (architecture === "x64") instructions.push([0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000]);
  // io_uring can issue socket/connect operations without the socket syscall.
  // New mount APIs, pidfd_getfd and process_madvise are also unnecessary here.
  for (const syscall of [...table.deny, 425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 440, 442])
    instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  // Modern libc falls back to clone when clone3 reports ENOSYS.
  instructions.push([0x15, 0, 1, 435], [0x06, 0, 0, 0x00050026], [0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = yes;
    bytes[index * 8 + 3] = no;
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  return bytes;
}

async function trustedSystemExecutable(
  candidates: readonly string[],
  name: string,
): Promise<string> {
  for (const candidate of candidates) {
    if (!(await existing(candidate))) continue;
    const executable = await realpath(candidate);
    let ancestor = executable;
    while (true) {
      const stat = await lstat(ancestor);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
        throw new Error(
          `${name} and its ancestors must be root-owned and not group/world writable.`,
        );
      if (ancestor === "/") break;
      ancestor = dirname(ancestor);
    }
    const executableStat = await lstat(executable);
    if (!executableStat.isFile() || (executableStat.mode & 0o6000) !== 0)
      throw new Error(`${name} must be a regular executable without setuid/setgid bits.`);
    await access(executable, constants.X_OK);
    return executable;
  }
  throw new Error(`Install trusted ${name}; system isolation is mandatory.`);
}

const runTrusted = promisify(execFile);
async function verifyBubblewrapVersion(executable: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await runTrusted(executable, ["--version"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    timeout: 5000,
    maxBuffer: 1024,
    signal,
  });
  const version = /^bubblewrap (\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout);
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 12))
    throw new Error("System isolation requires bubblewrap 0.12.0 or newer (GHSA-pxhw-h44j-8pfx).");
}

async function linuxProcessLimit(): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0)
    throw new Error(
      "Process isolation requires an unprivileged Linux account; root execution is unsupported.",
    );
  const processes = await readdir("/proc");
  if (processes.length > 100_000) throw new Error("Process metadata exceeds its isolation limit.");
  let threads = 0;
  for (const entry of processes) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const path = join("/proc", entry);
      if ((await lstat(path)).uid !== uid) continue;
      threads += (await readdir(join(path, "task"))).length;
      if (threads > 100_000) throw new Error("Thread metadata exceeds its isolation limit.");
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  return Math.max(1, threads) + 64;
}

async function verifyMacDetachmentBoundary(
  supervisor: string,
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((accept, reject) => {
    const probe = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, supervisor, "--probe-detachment"],
      {
        cwd,
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostics = "";
    probe.stderr.on("data", (chunk: Buffer) => {
      if (diagnostics.length < 4096)
        diagnostics += chunk.toString("utf8").slice(0, 4096 - diagnostics.length);
    });
    const abort = () => probe.kill("SIGKILL");
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    probe.once("error", (error) => {
      cleanup();
      reject(error);
    });
    probe.once("close", (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason ?? new Error("Sandbox initialization cancelled"));
      else if (code === 0) accept();
      else
        reject(
          new Error(
            `macOS kernel detachment restrictions could not be verified: ${diagnostics.trim() || `probe exit ${code}`}`,
          ),
        );
    });
    if (signal?.aborted) abort();
  });
}

/** No command is executed before the operating-system sandbox is installed. */
export async function prepareSandbox(request: SandboxRequest): Promise<PreparedSandbox> {
  request.signal?.throwIfAborted();
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "System isolation requires macOS or Linux/WSL with bubblewrap; execution refused.",
    );
  if (request.access !== "read" && !request.staged)
    throw new Error("Write-capable sandbox execution requires a disposable staged workspace.");
  const root = await realpath(request.root);
  const cwd = await realpath(request.cwd);
  if (!pathInside(root, cwd))
    throw new Error("Sandbox working directory must remain inside the workspace.");
  const executable = await directMacPython(await executablePath(request.command, cwd));
  await assertTrustedExecutable(executable, root, request.originalRoot ?? root);
  const runtimes = await trustedHostRuntimeExecutables(request.originalRoot ?? root);
  const runtimeExecutables = runtimes.executables;
  const readDirectories = await canonicalDirectories(root, request.readDirectories ?? [root]);
  const writeDirectories =
    request.access === "read"
      ? []
      : await canonicalDirectories(root, request.writeDirectories ?? readDirectories);
  for (const directory of writeDirectories)
    if (!readDirectories.some((allowed) => pathInside(allowed, directory)))
      throw new Error("Writable sandbox directories must also be readable.");
  const readOnlyDirectories = await canonicalDirectories(root, request.readOnlyDirectories ?? []);
  const deniedPaths = (request.deniedPaths ?? []).map((path) => resolve(root, path));
  if (deniedPaths.some((path) => !pathInside(root, path)))
    throw new Error("Sandbox deny paths must remain inside the workspace.");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "vcli-sandbox-")));
  const home = join(temporary, "home");
  const scratch = join(temporary, "tmp");
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(temporary, { recursive: true, force: true });
  };
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    const env = sandboxEnvironment(home, scratch, request.environment);
    const runtimeBin = join(temporary, "bin");
    await mkdir(runtimeBin, { mode: 0o700 });
    for (const [name, target] of runtimes.commands) await symlink(target, join(runtimeBin, name));
    env.PATH = `${runtimeBin}:${env.PATH}`;
    request.signal?.throwIfAborted();
    if (process.platform === "darwin") {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      const supervisor = await prepareProcessSupervisor();
      await verifyMacDetachmentBoundary(
        supervisor,
        macSandboxProfile({
          readDirectories,
          writeDirectories,
          deniedPaths,
          readOnlyDirectories,
          executable: supervisor,
          runtimeExecutables,
          temporary,
          root,
          allowGitRead: request.allowGitRead ?? false,
        }),
        cwd,
        env,
        request.signal,
      );
      request.signal?.throwIfAborted();
      return {
        command: supervisor,
        args: [
          "--parent",
          String(process.pid),
          "--",
          "/usr/bin/sandbox-exec",
          "-p",
          macSandboxProfile({
            readDirectories,
            writeDirectories,
            deniedPaths,
            readOnlyDirectories,
            executable,
            runtimeExecutables,
            temporary,
            root,
            allowGitRead: request.allowGitRead ?? false,
          }),
          executable,
          ...request.args,
        ],
        cwd,
        env,
        stdioFds: [],
        dispose,
      };
    }
    const bwrap = await trustedSystemExecutable(
      ["/usr/bin/bwrap", "/bin/bwrap"],
      "bubblewrap 0.12 or newer with --disable-userns support",
    );
    await verifyBubblewrapVersion(bwrap, request.signal);
    const prlimit = await trustedSystemExecutable(
      ["/usr/bin/prlimit", "/bin/prlimit"],
      "util-linux prlimit",
    );
    const processLimit = await linuxProcessLimit();
    const args = [
      "--unshare-all",
      "--unshare-user",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--disable-userns",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
    ];
    const bind = async (source: string, target: string, writable: boolean) => {
      // Only immutable system paths, explicit runtime files and parent-created private
      // snapshot paths enter here. The actual workspace is never bound into a child.
      args.push(writable ? "--bind" : "--ro-bind", source, target);
    };
    for (const system of [
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/lib64",
      "/usr/libexec",
      "/usr/share",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
    ])
      if (await existing(system)) await bind(await realpath(system), system, false);
    for (const file of new Set([executable, ...runtimeExecutables]))
      if (
        ![
          "/usr/bin",
          "/usr/sbin",
          "/usr/lib",
          "/usr/lib64",
          "/usr/libexec",
          "/bin",
          "/sbin",
          "/lib",
          "/lib64",
        ].some((directory) => pathInside(directory, file))
      )
        await bind(file, file, false);
    for (const directory of readDirectories)
      await bind(directory, directory, writeDirectories.includes(directory));
    for (const directory of writeDirectories)
      if (!readDirectories.includes(directory)) await bind(directory, directory, true);
    await bind(temporary, temporary, true);
    for (const directory of readOnlyDirectories) await bind(directory, directory, false);
    // Missing mount targets are created only in the disposable staged workspace.
    // No protective placeholder is ever created in the actual user workspace.
    const privatePaths = [
      join(root, ".vcli"),
      join(root, ".git"),
      join(root, ".env"),
      ...deniedPaths,
    ];
    for (const path of privatePaths) {
      if (request.allowGitRead && path === join(root, ".git")) {
        if (await existing(path)) await bind(await realpath(path), path, false);
        continue;
      }
      if (!(await existing(path))) {
        if (!request.staged) continue;
        if (path === join(root, ".env")) {
          const placeholder = openSync(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | 0x80000,
            0o600,
          );
          closeSync(placeholder);
        } else await mkdir(path, { recursive: true, mode: 0o700 });
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error("Protected sandbox paths cannot be symbolic links.");
      args.push(
        stat.isDirectory() ? "--tmpfs" : "--ro-bind",
        ...(stat.isDirectory() ? [path, "--remount-ro", path] : ["/dev/null", path]),
      );
    }
    const seccompPath = join(temporary, "seccomp.bpf");
    writeFileSync(seccompPath, linuxSeccompFilter(), { mode: 0o600, flag: "wx" });
    args.push("--seccomp", "3", "--chdir", cwd, "--", executable, ...request.args);
    return {
      // Bun 1.3.13 can close/reuse numeric inherited stdio descriptors in its
      // parent. Open the one consumed seccomp file in a fixed trusted shell, never
      // pass a host directory descriptor through the Bun subprocess boundary.
      command: "/bin/sh",
      args: [
        "-c",
        'exec 3<"$1"; shift; exec "$@"',
        "vcli-sandbox",
        seccompPath,
        prlimit,
        "--nofile=256:256",
        "--fsize=67108864:67108864",
        "--cpu=120:120",
        `--nproc=${processLimit}:${processLimit}`,
        "--",
        bwrap,
        ...args,
      ],
      cwd: "/",
      env,
      stdioFds: [],
      dispose,
    };
  } catch (error) {
    await dispose();
    throw new Error(
      `System sandbox unavailable; execution refused: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Shared by sandbox workspace scanning; no private file is opened while enumerating. */
export function sandboxPrivatePath(root: string, path: string, allowGitRead = false): boolean {
  const parts = relative(root, path).split(sep);
  if (allowGitRead && parts[0]?.toLowerCase() === ".git") parts.shift();
  return privateProjectPath(parts.join("/"));
}
