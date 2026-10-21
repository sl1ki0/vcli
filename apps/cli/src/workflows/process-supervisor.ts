import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import supervisorSource from "./native/process-supervisor.c" with { type: "text" };

declare const __VCLI_PROCESS_SUPERVISOR_BASE64__: string | undefined;

const run = promisify(execFile);
let executable: Promise<string> | undefined;

/** Compile only bundled source with a fixed system compiler, never project code. */
export function prepareProcessSupervisor(): Promise<string> {
  executable ??= (async () => {
    if (process.platform !== "darwin") throw new Error("macOS process supervisor is unavailable");
    const directory = await mkdtemp(join(tmpdir(), "vcli-process-supervisor-"));
    await chmod(directory, 0o700);
    const source = join(directory, "supervisor.c");
    const output = join(directory, "supervisor");
    try {
      if (typeof __VCLI_PROCESS_SUPERVISOR_BASE64__ === "string")
        await writeFile(output, Buffer.from(__VCLI_PROCESS_SUPERVISOR_BASE64__, "base64"), {
          mode: 0o700,
          flag: "wx",
        });
      else {
        await writeFile(source, supervisorSource, { mode: 0o600, flag: "wx" });
        await run(
          "/usr/bin/clang",
          ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output],
          {
            env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
            timeout: 30_000,
            maxBuffer: 8192,
          },
        );
        await rm(source);
      }
      await chmod(output, 0o700);
      process.once("exit", () => {
        // Runtime temp cleanup is best effort; no user or project data lives here.
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {}
      });
      return output;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(
        "macOS system isolation requires the bundled process supervisor or Xcode Command Line Tools",
        { cause: error },
      );
    }
  })();
  return executable;
}
