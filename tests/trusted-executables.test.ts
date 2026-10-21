import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("startup PATH cannot turn project shims or private files into host runtime grants", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vcli-runtime-path-")));
  roots.push(root);
  const project = join(root, "project");
  const stage = join(root, "stage");
  const privateFile = join(root, ".env-synthetic-executable");
  await mkdir(project);
  await mkdir(stage);
  await writeFile(privateFile, "SYNTHETIC_PRIVATE_RUNTIME_SENTINEL\n", { mode: 0o700 });
  const dependencyBin = join(root, "node_modules/.bin");
  const projectBin = join(project, "bin");
  const externalBin = join(root, "external-bin");
  for (const directory of [dependencyBin, projectBin, externalBin]) {
    await mkdir(directory, { recursive: true });
    await symlink(privateFile, join(directory, "node"));
  }
  const projectRuntime = join(projectBin, "python3");
  await writeFile(projectRuntime, "PROJECT_RUNTIME_SENTINEL\n", { mode: 0o700 });
  const projectAlias = join(root, "project-alias");
  await symlink(projectBin, projectAlias);
  const program = `
    import {trustedHostRuntimeExecutables} from ${JSON.stringify(new URL("../apps/cli/src/workflows/trusted-executables.ts", import.meta.url).href)};
    import {prepareSandbox} from ${JSON.stringify(new URL("../apps/cli/src/workflows/process-sandbox.ts", import.meta.url).href)};
    const runtimes = await trustedHostRuntimeExecutables(process.env.TEST_PROJECT);
    const prepared = await prepareSandbox({root:process.env.TEST_STAGE,cwd:process.env.TEST_STAGE,originalRoot:process.env.TEST_PROJECT,command:'/bin/cat',args:[process.env.TEST_PRIVATE],access:'read',staged:true});
    try {
      const child=Bun.spawn([prepared.command,...prepared.args],{cwd:prepared.cwd,env:prepared.env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
      const stdout=await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      const code=await child.exited;
      console.log(JSON.stringify({executables:runtimes.executables,stdout,code}));
    } finally { await prepared.dispose(); }
  `;
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: project,
    env: {
      ...process.env,
      PATH: [
        ".",
        "bin",
        dependencyBin,
        projectBin,
        projectAlias,
        externalBin,
        process.env.PATH,
      ].join(":"),
      TEST_PROJECT: project,
      TEST_STAGE: stage,
      TEST_PRIVATE: privateFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  const result = JSON.parse(stdout) as { executables: string[]; stdout: string; code: number };
  expect(result.executables).not.toContain(privateFile);
  expect(result.executables).not.toContain(projectRuntime);
  expect(result.stdout).not.toContain("SYNTHETIC_PRIVATE_RUNTIME_SENTINEL");
  expect(result.code).not.toBe(0);
});
