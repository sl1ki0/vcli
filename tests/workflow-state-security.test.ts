import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRunPlan, type Session } from "@vcli/core";
import { LocalTaskStore } from "../apps/cli/src/workflows/tasks.ts";
import { readPlans, savePlan } from "../apps/cli/src/workflows/plans.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "vcli-workflow-state-security-"));
  roots.push(root);
  return root;
}
function planSession(): Session {
  return {
    id: "fixture",
    root: "/fixture",
    provider: "fixture",
    model: "fixture",
    status: "awaiting-plan",
    mode: "plan",
    createdAt: "now",
    updatedAt: "now",
    messages: [],
    usage: { input: 0, output: 0, cached: 0 },
    ledger: {
      goal: "Inspect",
      constraints: [],
      decisions: [],
      pending: [],
      touchedPaths: [],
      verification: [],
    },
    plan: createRunPlan(
      {
        goal: "Inspect",
        steps: [
          {
            id: "inspect",
            description: "Inspect source",
            dependencies: [],
            tools: ["files_read"],
            verificationTool: "files_read",
            doneWhen: "Source inspected",
          },
        ],
        risks: [],
        assumptions: [],
        doneWhen: "Source inspected",
      },
      "plan",
    ),
  };
}

for (const component of [".vcli", ".vcli/state", ".vcli/state/plans"])
  test(`task and plan storage refuses a symbolic ${component} directory`, async () => {
    const root = await directory();
    const outside = await directory();
    const path = join(root, component);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    await writeFile(join(outside, "sentinel"), "outside must remain unchanged");
    if (component !== ".vcli/state/plans") {
      await expect(new LocalTaskStore(root).list()).rejects.toThrow("symbolic");
      await expect(
        new LocalTaskStore(root).create({ title: "Blocked" }, "fixture"),
      ).rejects.toThrow("symbolic");
    }
    await expect(readPlans(root)).rejects.toThrow("symbolic");
    await expect(savePlan(root, planSession())).rejects.toThrow("symbolic");
    expect(await readdir(outside)).toEqual(["sentinel"]);
  });

for (const kind of ["symbolic", "hard"] as const)
  for (const filename of ["tasks.json", "tasks.json.lock"])
    test(`tasks reject a ${kind} link at ${filename} without reading or replacing it`, async () => {
      const root = await directory();
      const outside = await directory();
      const source = join(outside, "sensitive");
      const content = JSON.stringify({ version: 1, tasks: [] });
      await writeFile(source, content);
      await mkdir(join(root, ".vcli/state"), { recursive: true });
      const target = join(root, ".vcli/state", filename);
      await (kind === "symbolic" ? symlink(source, target) : link(source, target));
      const tasks = new LocalTaskStore(root);
      if (filename === "tasks.json") await expect(tasks.list()).rejects.toThrow(/Storage/);
      await expect(tasks.create({ title: "Blocked" }, "fixture")).rejects.toThrow(/Storage/);
      expect(await readFile(source, "utf8")).toBe(content);
      expect(await readdir(join(root, ".vcli/state"))).toEqual([filename]);
    });

for (const kind of ["symbolic", "hard"] as const)
  for (const extension of ["md", "json"])
    test(`plans reject ${kind}-linked ${extension} files and preserve both destination files`, async () => {
      const root = await directory();
      const outside = await directory();
      const source = join(outside, "sensitive");
      const content = "sensitive external content";
      await writeFile(source, content);
      await mkdir(join(root, ".vcli/state/plans"), { recursive: true });
      const target = join(root, ".vcli/state/plans", `fixture.${extension}`);
      await (kind === "symbolic" ? symlink(source, target) : link(source, target));
      if (extension === "md") await expect(readPlans(root)).rejects.toThrow(/Storage/);
      await expect(savePlan(root, planSession())).rejects.toThrow(/Storage/);
      expect(await readFile(source, "utf8")).toBe(content);
      expect(await readdir(join(root, ".vcli/state/plans"))).toEqual([`fixture.${extension}`]);
    });

test("explicit external state refuses a symbolic plans subdirectory", async () => {
  const root = await directory();
  const state = await directory();
  const outside = await directory();
  await symlink(outside, join(state, "plans"));
  await expect(readPlans(root, undefined, { directory: state })).rejects.toThrow("symbolic");
  await expect(savePlan(root, planSession(), { directory: state })).rejects.toThrow("symbolic");
  expect(await readdir(outside)).toEqual([]);
});

test("plan writes validate their run ID before constructing output paths", async () => {
  const root = await directory();
  await expect(savePlan(root, { ...planSession(), id: "../../escaped" })).rejects.toThrow(
    "Invalid plan run ID",
  );
  expect(await readdir(root)).toEqual([]);
});
