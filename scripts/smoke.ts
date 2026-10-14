import { mkdtemp, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminalSmoke } from "./smoke-terminal.ts";
import { onboardingSmoke } from "./smoke-onboarding.ts";
import { resourceLimitsSmoke } from "./smoke-resource-limits.ts";
import { chatSmoke } from "./smoke-chat.ts";
import { workflowsSmoke } from "./smoke-workflows.ts";
import { exitSmoke } from "./smoke-exit.ts";
import { cancellationSmoke } from "./smoke-cancel.ts";
import { livePermissionsSmoke } from "./smoke-live-permissions.ts";
import { approvalSmoke } from "./smoke-approval.ts";
import { toolHistorySmoke } from "./smoke-tool-history.ts";
import { homeworkSmoke } from "./smoke-homework.ts";

const directory = await mkdtemp(join(tmpdir(), "vcli-packaged-"));
const binary = join(directory, "vcli");
await copyFile(resolve(import.meta.dir, "../dist/vcli"), binary);

async function run(...args: string[]): Promise<string> {
  const process = Bun.spawn([binary, ...args], {
    cwd: directory,
    env: { ...Bun.env, VCLI_CONFIG_HOME: join(directory, "configuration") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(`Packaged ${args.join(" ")} failed (${code}): ${stderr}`);
  if (stdout.includes("\u001b")) throw new Error("Non-TTY command emitted terminal escapes");
  return stdout;
}

try {
  await writeFile(
    join(directory, "app.ts"),
    'import { save } from "./store";\nexport const run = () => save("ready");\n',
  );
  await writeFile(join(directory, "store.ts"), "export const save = (value: string) => value;\n");
  await writeFile(join(directory, "bunfig.toml"), 'preload = ["./missing-preload.ts"]\n');
  await writeFile(join(directory, ".env"), "VCLI_CONFIG_HOME=/this/must/not/be/loaded\n");
  const graph = JSON.parse(await run("architecture", "scan", "--json"));
  if (
    !graph.nodes.some((node: { path?: string }) => node.path === "app.ts") ||
    !graph.edges.some((edge: { kind: string }) => edge.kind === "import")
  )
    throw new Error("Packaged source analyzer missed the dependency");
  for (const format of ["svg", "png", "json"])
    await run("architecture", "export", "--format", format);
  const png = await readFile(join(directory, "architecture.png"));
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("Packaged rasterizer did not produce PNG");
  if (!(await readFile(join(directory, "architecture.svg"), "utf8")).includes("<path"))
    throw new Error("Packaged layout worker did not route edges");
  await run("sessions", "list");
  await run("config", "set", "permission", "read-only");
  if (JSON.parse(await run("config", "show")).permission !== "read-only")
    throw new Error("Packaged config persistence failed");
  await run("plugins", "list");
  await terminalSmoke(binary, directory, "off");
  await terminalSmoke(binary, directory, "kitty");
  await onboardingSmoke(binary);
  await chatSmoke(binary);
  await workflowsSmoke(binary);
  await approvalSmoke(binary);
  await livePermissionsSmoke(binary);
  await cancellationSmoke(binary);
  await exitSmoke(binary);
  await toolHistorySmoke(binary);
  await homeworkSmoke(binary);
  await resourceLimitsSmoke(binary);
  console.log(
    `Standalone smoke passed on ${process.platform}/${process.arch}: analysis, worker/font, exports, SQLite, config, plugins, PTY tree/Kitty, first-run setup, formatted chat, restored tool history/artifacts, invalid-request stop, visual permission decisions, planning/build transitions, tasks, checkpoints, homework policy/plan/Bash/resume/rollback, terminal cleanup and capped descriptors. No checkout dependencies.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
