import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { terminalSmoke } from "./smoke-terminal.ts";

const descriptorLimit = 256;
const moduleCount = 384;
const modulesPerGroup = 16;
const childTimeoutMs = 30_000;

// Cap only the child. A hard cap prevents Bun from raising the soft cap at startup.
const limitedExec = `set -e
ulimit -S -n ${descriptorLimit}
ulimit -H -n ${descriptorLimit}
unset BUN_OPTIONS BUN_BE_BUN NODE_OPTIONS VCLI_DEBUG
unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY VCLI_COMPATIBLE_API_KEY
exec "$@"`;

function limitedCommand(program: string, args: string[] = []): string[] {
  return ["/bin/sh", "-c", limitedExec, "vcli-resource-limits", program, ...args];
}

async function runLimited(directory: string, program: string, args: string[]): Promise<string> {
  const child = Bun.spawn(limitedCommand(program, args), {
    cwd: directory,
    env: { ...Bun.env, VCLI_CONFIG_HOME: join(directory, "configuration") },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, childTimeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error("Packaged descriptor-limit check timed out");
    if (code)
      throw new Error(`Packaged descriptor-limit check failed (${code}): ${stderr.slice(-1600)}`);
    if (stdout.includes("\u001b"))
      throw new Error("Non-TTY descriptor-limit check emitted terminal escapes");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function modulePath(index: number): string {
  const group = Math.floor(index / modulesPerGroup)
    .toString()
    .padStart(2, "0");
  const module = (index % modulesPerGroup).toString().padStart(2, "0");
  return join("src", `group-${group}`, `module-${module}.ts`);
}

async function createRepository(directory: string): Promise<void> {
  for (let index = 0; index < moduleCount; index++) {
    const path = modulePath(index);
    await mkdir(dirname(join(directory, path)), { recursive: true });
    const previous = index
      ? relative(dirname(path), modulePath(index - 1)).replace(/\.ts$/, "")
      : "";
    const source = index
      ? `import { value as previous } from "${previous.startsWith(".") ? previous : `./${previous}`}";\nexport const value = previous + 1;\n`
      : "export const value = 0;\n";
    await writeFile(join(directory, path), source);
  }
}

/** Exercises the standalone client with a process-local soft and hard NOFILE cap. */
export async function resourceLimitsSmoke(binary: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "vcli-descriptor-limits-"));
  try {
    const limits = await runLimited(directory, "/bin/sh", ["-c", "ulimit -S -n; ulimit -H -n"]);
    if (limits.trim() !== `${descriptorLimit}\n${descriptorLimit}`)
      throw new Error("Descriptor-limit child did not inherit both caps");

    if (!(await runLimited(directory, binary, ["--help"])).includes("architecture"))
      throw new Error("Packaged help was unavailable with capped descriptors");

    await createRepository(directory);
    const graph = JSON.parse(
      await runLimited(directory, binary, ["architecture", "scan", "--json"]),
    ) as {
      nodes: { kind: string; path?: string }[];
      edges: { kind: string }[];
    };
    if (
      graph.nodes.filter((node) => node.kind === "module").length !== moduleCount ||
      graph.edges.filter((edge) => edge.kind === "import").length !== moduleCount - 1
    )
      throw new Error("Descriptor-limit scan did not preserve the synthetic module chain");

    for (const format of ["svg", "png"]) {
      await runLimited(directory, binary, ["architecture", "export", "--format", format]);
    }
    if (!(await readFile(join(directory, "architecture.svg"), "utf8")).includes("<path"))
      throw new Error("Descriptor-limit layout worker did not route edges");
    const png = await readFile(join(directory, "architecture.png"));
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new Error("Descriptor-limit rasterizer did not produce PNG");

    await terminalSmoke(limitedCommand(binary), directory, "off");
    await terminalSmoke(limitedCommand(binary), directory, "kitty");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
