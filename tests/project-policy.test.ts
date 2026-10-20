import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  PermissionGate,
  ToolRegistry,
  type ProviderAdapter,
  type ToolContext,
} from "@vcli/core";
import { createArchitectureService } from "@vcli/architecture";
import { SqliteSessionStore } from "../apps/cli/src/store.ts";
import { createLocalWorkflows } from "../apps/cli/src/workflows/runtime.ts";
import { fileTools } from "../apps/cli/src/tools/files.ts";
import { inspectionTools } from "../apps/cli/src/tools/inspection.ts";
import { executeProcess } from "../apps/cli/src/tools/process.ts";
import { shellTool } from "../apps/cli/src/tools/shell.ts";
import { ProjectPolicy, simpleCommand } from "../apps/cli/src/workflows/policy.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-policy-")));
  directories.push(directory);
  const root = join(directory, "project");
  await mkdir(root);
  await mkdir(join(root, "private"));
  await writeFile(join(root, "source.txt"), "visible needle\n");
  await writeFile(join(root, "private/secret.txt"), "hidden needle\n");
  const path = join(directory, "policy.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      commands: {
        allow: ["python3 -m unittest -v", "printf okay", "cat private/secret.txt"],
        deny: ["printf okay"],
      },
      directories: { allow: [root], deny: [join(root, "private")] },
    }),
  );
  const policy = await ProjectPolicy.load(root, path);
  const context: ToolContext = {
    root,
    sessionId: "policy-test",
    signal: new AbortController().signal,
    authorizePath: (path, write) => policy.resolvePath(path, { write, allowRoot: true }),
  };
  return { directory, root, path, policy, context };
}

describe("project policy", () => {
  test("allow exact command, deny precedence, forbidden cwd and path arguments", async () => {
    const { root, policy } = await fixture();
    expect(await policy.assertCommand("python3 -m unittest -v")).toBe(root);
    await expect(policy.assertCommand("printf okay")).rejects.toThrow("denied");
    await expect(policy.assertCommand("python3 -m unittest -v", "private")).rejects.toThrow(
      "Directory",
    );
    await expect(policy.assertCommand("cat private/secret.txt")).rejects.toThrow("Directory");
    await expect(policy.assertCommand("python3 -m unittest -v; pwd")).rejects.toThrow("simple");
  });
  test("denies nested Bash, substitution, redirection, traversal and symlinks", async () => {
    const { root, directory, policy, context } = await fixture();
    for (const command of [
      "bash -c 'pwd'",
      "env python3 -m unittest",
      "python3 -c 'print(1)'",
      "printf $(pwd)",
      "printf x > source.txt",
      "printf x | cat",
    ])
      expect(() => simpleCommand(command)).toThrow();
    await symlink(directory, join(root, "linked"));
    for (const path of [
      "../policy.json",
      join(directory, "policy.json"),
      "linked/policy.json",
      "private/secret.txt",
      ".vcli/config.json",
    ])
      await expect(policy.resolvePath(path)).rejects.toThrow();
    const read = fileTools.find((tool) => tool.name === "files_read")!;
    await expect(
      read.execute({ path: "../policy.json" }, { ...context, authorizePath: undefined }),
    ).rejects.toThrow();
  });
  test("search filters denied directories before reading their contents", async () => {
    const { context } = await fixture();
    const tool = fileTools.find((tool) => tool.name === "files_search")!;
    const result = await tool.execute({ query: "needle" }, context);
    expect(result.fullOutput).toContain("visible needle");
    expect(result.fullOutput).not.toContain("hidden needle");
    expect(result.fullOutput).not.toContain("secret.txt");
  });
  test("strict directory policy is inherited by read-only explorers", async () => {
    const { root, directory, path } = await fixture();
    const stateDirectory = join(directory, "state");
    const store = await SqliteSessionStore.open(root, { directory: stateDirectory });
    const registry = new ToolRegistry();
    fileTools.forEach((tool) => registry.register({ ...tool, eager: true }));
    let parentTurns = 0;
    let childTurns = 0;
    const provider: ProviderAdapter = {
      id: "policy-fixture",
      model: "policy-fixture",
      contextWindow: 32_768,
      async *stream(request) {
        if (request.messages[0]!.text.includes("Delegated task:")) {
          if (++childTurns === 1)
            yield {
              type: "tool-call",
              call: {
                id: "private-read",
                name: "files_read",
                arguments: { path: "private/secret.txt" },
              },
            };
          else {
            const result = request.messages.find(
              (message) => message.toolCallId === "private-read",
            );
            expect(result?.text).toContain("Directory");
            expect(result?.text).not.toContain("hidden needle");
            yield { type: "text", text: "The requested path is blocked by project policy." };
          }
        } else if (++parentTurns === 1)
          yield {
            type: "tool-call",
            call: {
              id: "explorer",
              name: "subagent_explore",
              arguments: { prompt: "Inspect the private file", tokens: 4000 },
            },
          };
        else yield { type: "text", text: "Explorer result received." };
        yield { type: "usage", usage: { input: 10, output: 5, cached: 0 } };
        yield { type: "done" };
      },
    };
    const permissions = new PermissionGate("yolo");
    const architecture = createArchitectureService();
    const workflows = await createLocalWorkflows({
      root,
      registry,
      provider,
      architecture,
      store,
      permissions,
      policyPath: path,
      stateDirectory,
      runtime: () => runtime,
    });
    const runtime: AgentRuntime = new AgentRuntime({
      root,
      provider,
      architecture,
      store,
      tools: registry,
      permissions,
      beforeTool: workflows.beforeTool,
      executeTool: workflows.executeTool,
    });
    try {
      const session = await runtime.run("Delegate the inspection", new AbortController().signal);
      expect(session.status).toBe("complete");
      expect(childTurns).toBe(2);
      expect(session.runState!.calls.explorer!.result?.isError).toBe(false);
      const child = (await store.list(root)).find((item) => item.id !== session.id)!;
      expect(
        child.messages.some(
          (message) => message.role === "tool" && message.text.includes("hidden needle"),
        ),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
  test("git diff filters denied descendants even for an explicit directory scope", async () => {
    const { context, root } = await fixture();
    for (const args of [
      ["init", "-q"],
      ["add", "--", "source.txt", "private/secret.txt"],
    ])
      expect((await executeProcess("git", args, context)).code).toBe(0);
    await writeFile(join(root, "source.txt"), "allowed change\n");
    await writeFile(join(root, "private/secret.txt"), "denied change must not leak\n");
    const diff = inspectionTools.find((tool) => tool.name === "git_diff")!;
    for (const args of [{}, { path: "." }]) {
      const result = await diff.execute(args, context);
      expect(result.fullOutput).toContain("allowed change");
      expect(result.fullOutput).not.toContain("denied change");
      expect(result.fullOutput).not.toContain("private/secret.txt");
    }
  });
  test("portable relative directory rules still reject nested traversal and state symlink escapes", async () => {
    const { root, directory, path } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        commands: { allow: ["cat ../source.txt", "private/script.sh", "rm source.txt"], deny: [] },
        directories: { allow: ["."], deny: ["private"] },
      }),
    );
    const policy = await ProjectPolicy.load(root, path);
    await expect(policy.resolvePath("private/secret.txt")).rejects.toThrow("Directory");
    await mkdir(join(root, "sub"));
    await expect(policy.assertCommand("cat ../source.txt", "sub")).rejects.toThrow("traversal");
    await expect(policy.assertCommand("private/script.sh")).rejects.toThrow("Directory");
    expect(
      policy.requiresApproval({
        id: "delete",
        name: "shell_run",
        arguments: { command: "rm source.txt" },
      }),
    ).toBe(true);
    expect(
      (await ProjectPolicy.load(root)).requiresApproval({
        id: "delete",
        name: "files_delete",
        arguments: { path: "source.txt" },
      }),
    ).toBe(false);
    await symlink(root, join(directory, "state-link"));
    await expect(
      ProjectPolicy.load(root, path, { stateDirectory: join(directory, "state-link/new") }),
    ).rejects.toThrow("outside");
  });
  test("policy must be external and rules cannot allow outside the project", async () => {
    const { root, directory, path } = await fixture();
    await writeFile(join(root, "policy.json"), await readFile(path));
    await expect(ProjectPolicy.load(root, join(root, "policy.json"))).rejects.toThrow("outside");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        commands: { allow: [], deny: [] },
        directories: { allow: [directory], deny: [] },
      }),
    );
    await expect(ProjectPolicy.load(root, path)).rejects.toThrow("inside");
    await expect(
      ProjectPolicy.load(root, undefined, { stateDirectory: join(root, "state") }),
    ).rejects.toThrow("outside");
  });
  test("Bash returns separate streams, explicit cwd and bounded output", async () => {
    const { context, root } = await fixture();
    const result = await shellTool.execute(
      { command: "printf out; printf err >&2; exit 3", cwd: "." },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ stdout: "out", stderr: "err", code: 3, cwd: root });
    const capped = await shellTool.execute(
      { command: "printf 123456789", maxOutputBytes: 4 },
      context,
    );
    expect(capped.details).toMatchObject({ stdout: "1234", truncated: true });
    const timed = await shellTool.execute({ command: "sleep 2", timeoutMs: 100 }, context);
    expect(timed.details).toMatchObject({ timedOut: true });
  });
});
