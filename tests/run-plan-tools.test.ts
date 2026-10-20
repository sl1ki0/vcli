import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunPlan,
  decideRunPlan,
  recordPlanToolResult,
  type Session,
  type RuntimeEvent,
} from "@vcli/core";
import { createPlanTools } from "../apps/cli/src/tools/plans.ts";
import { readPlans, savePlan, syncPlanChat } from "../apps/cli/src/workflows/plans.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(): Session {
  return {
    id: "run-plan-fixture",
    root: "/fixture",
    provider: "fixture",
    model: "fixture",
    status: "running",
    mode: "plan",
    messages: [{ role: "user", text: "Fix totals" }],
    ledger: {
      goal: "Fix totals",
      constraints: [],
      decisions: [],
      pending: [],
      touchedPaths: [],
      verification: [],
    },
    usage: { input: 0, output: 0, cached: 0 },
    createdAt: "created",
    updatedAt: "updated",
  };
}
const input = {
  goal: "Fix totals",
  steps: [
    {
      id: "test",
      description: "Run unchanged tests",
      dependencies: [],
      tools: ["shell_run"],
      doneWhen: "Tests pass",
      verificationTool: "shell_run",
    },
  ],
  risks: [],
  assumptions: [],
  doneWhen: "Tests pass without changes",
};

test("structured plans persist with run IDs and chat presentation never duplicates provider context", async () => {
  const value = session();
  const events: RuntimeEvent[] = [];
  const snapshots: Session[] = [];
  const [publish, task] = createPlanTools({
    getSession: () => value,
    save: async (next) => {
      snapshots.push(structuredClone(next));
    },
    emit: (event) => {
      events.push(event);
    },
    hasTool: (name) => name === "shell_run",
  });
  const context = { root: value.root, sessionId: value.id, signal: new AbortController().signal };
  await publish!.execute(input, context);
  expect(value.plan?.status).toBe("draft");
  expect(value.chat?.[0]?.text).toContain("Execution plan");
  expect(value.chat?.[0]?.text).toContain("Run: `run-plan-fixture`");
  expect(value.messages).toHaveLength(1);
  expect(events[0]?.type).toBe("plan");
  await expect(task!.execute({ action: "start", taskId: "test" }, context)).rejects.toThrow(
    "approval",
  );
  decideRunPlan(value.plan!, true);
  value.mode = "build";
  await task!.execute({ action: "start", taskId: "test" }, context);
  await expect(
    task!.execute({ action: "verify", taskId: "test", evidenceCallIds: ["claim"] }, context),
  ).rejects.toThrow("recorded");
  recordPlanToolResult(value.plan!, "test", "bash-ok", "shell_run", { text: "Exit 0\nOK" });
  await task!.execute({ action: "verify", taskId: "test", evidenceCallIds: ["bash-ok"] }, context);
  expect(snapshots.at(-1)?.plan?.steps[0]?.status).toBe("complete");
  expect(value.chat).toHaveLength(1);
  expect(value.chat?.[0]?.text).toContain("1/1 verified tasks");
  const root = await mkdtemp(join(tmpdir(), "vcli-plan-"));
  roots.push(root);
  await savePlan(root, value);
  expect(await readPlans(root, value.id)).toContain("1/1 verified tasks");
  const file = JSON.parse(
    await readFile(join(root, ".vcli/state/plans", `${value.id}.json`), "utf8"),
  );
  expect(file).toMatchObject({ runId: value.id, plan: { steps: [{ verifiedBy: ["bash-ok"] }] } });
  await expect(readPlans(root, "../outside")).rejects.toThrow("Invalid plan run ID");
});

test("a failed plan-state save cannot silently approve, start or complete in memory", async () => {
  const value = session();
  const [publish] = createPlanTools({
    getSession: () => value,
    save: async () => {
      throw new Error("disk full");
    },
  });
  await expect(
    publish!.execute(input, {
      root: value.root,
      sessionId: value.id,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("disk full");
  expect(value.plan).toBeUndefined();
  expect(value.chat).toBeUndefined();
  expect(() => syncPlanChat(value)).toThrow("No structured plan");
});

test("external run state keeps structured and chat plans outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "vcli-plan-external-"));
  const directory = await mkdtemp(join(tmpdir(), "vcli-plan-state-"));
  roots.push(root, directory);
  const value = session();
  value.plan = createRunPlan(input, "plan");
  await savePlan(root, value, { directory });
  expect(await readPlans(root, value.id, { directory })).toContain("Fix totals");
  expect(await Bun.file(join(directory, "plans", `${value.id}.json`)).exists()).toBe(true);
  expect(await Bun.file(join(root, ".vcli/state/plans", `${value.id}.md`)).exists()).toBe(false);
});
