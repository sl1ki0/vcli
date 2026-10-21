import { realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { privateProjectPath } from "./private-path.ts";

const SYSTEM_EXECUTABLE_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/Cellar",
  "/usr/local/Cellar",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app/Contents/Developer",
  "/Library/Frameworks/Python.framework",
  "/Library/Apple/usr/bin",
];
const within = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};
const HOST_RUNTIME_NAMES = ["bun", "node", "python3", "rg"] as const;
const INITIAL_HOST_PATH = (process.env.PATH ?? "").split(delimiter);
const mutableOrPrivate = (path: string, originalRoot?: string): boolean =>
  privateProjectPath(path) ||
  path.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules") ||
  (originalRoot !== undefined && within(originalRoot, path));

/** Only fixed runtime names resolve through the trusted initial host PATH. */
export async function trustedHostRuntimeExecutables(originalRoot?: string): Promise<{
  executables: string[];
  commands: ReadonlyMap<string, string>;
}> {
  const commands = new Map<string, string>();
  for (const name of HOST_RUNTIME_NAMES) {
    for (const directory of INITIAL_HOST_PATH) {
      // bun run prepends project node_modules/.bin. A project shim, including a
      // symlink to a private host executable, must never create a host read grant.
      if (!isAbsolute(directory) || mutableOrPrivate(directory, originalRoot)) continue;
      const found = Bun.which(name, { PATH: directory });
      if (!found || mutableOrPrivate(found, originalRoot)) continue;
      try {
        const canonical = await realpath(found);
        if (mutableOrPrivate(canonical, originalRoot)) continue;
        const executable = await directMacPython(canonical);
        if (mutableOrPrivate(executable, originalRoot)) continue;
        commands.set(name, executable);
        break;
      } catch (error) {
        if (name !== "python3") throw error;
        // Missing Xcode Python does not disable other installed runtimes.
      }
    }
  }
  return {
    executables: [...new Set([await realpath(process.execPath), ...commands.values()])],
    commands,
  };
}

/** Executing a host file also grants its bytes; private host scripts are no grant. */
export async function assertTrustedExecutable(
  executable: string,
  stagedRoot: string,
  originalRoot?: string,
): Promise<void> {
  const hostExecutable = await realpath(process.execPath);
  if (executable === hostExecutable) return;
  if (
    within(stagedRoot, executable) ||
    (!mutableOrPrivate(executable, originalRoot) &&
      SYSTEM_EXECUTABLE_ROOTS.some((root) => within(root, executable)))
  )
    return;
  if ((await trustedHostRuntimeExecutables(originalRoot)).executables.includes(executable)) return;
  throw new Error(
    "System isolation refuses executables outside the staged project and trusted runtime locations",
  );
}

/** Apple's front-end uses posix_spawn; enter its bundled interpreter directly. */
export async function directMacPython(executable: string): Promise<string> {
  if (process.platform !== "darwin") return executable;
  if (/\.framework\/Versions\/[^/]+\/bin\/python(?:3(?:\.\d+)?)?$/.test(executable)) {
    const candidate = join(
      dirname(dirname(executable)),
      "Resources/Python.app/Contents/MacOS/Python",
    );
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (executable !== "/usr/bin/python3") return executable;
  for (const base of [
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
  ]) {
    const candidate = `${base}/Library/Frameworks/Python3.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python`;
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "Sandboxed Python requires a directly executable interpreter; install Xcode Command Line Tools or Python",
  );
}
