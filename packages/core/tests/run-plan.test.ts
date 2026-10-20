import { describe, expect, test } from "bun:test";
import {
  createRunPlan,
  currentPlanTask,
  decideRunPlan,
  recordPlanToolResult,
  startPlanTask,
  unfinishedPlanTasks,
  validateRunPlan,
  verifyPlanTask,
  type RunPlanInput,
} from "../src/run-plan.ts";
import { estimateTokens, planContext } from "../src/context.ts";

const input: RunPlanInput = {
  goal: "Fix order totals while preserving tests",
  risks: ["Existing callers may rely on invalid discounts"],
  assumptions: ["Tests define supported behavior"],
  doneWhen: "Unchanged tests pass through Bash",
  steps: [
    {
      id: "inspect",
      description: "Read source and test expectations",
      dependencies: [],
      tools: ["files_read"],
      doneWhen: "Current behavior and required discount are identified",
      verificationTool: "files_read",
    },
    {
      id: "fix",
      description: "Correct percentage and validate range",
      dependencies: ["inspect"],
      tools: ["files_patch", "files_read"],
      doneWhen: "Source contains the corrected calculation",
      verificationTool: "files_read",
    },
    {
      id: "test",
      description: "Run unchanged tests through Bash",
      dependencies: ["fix"],
      tools: ["shell_run"],
      doneWhen: "Bash reports exit code zero",
      verificationTool: "shell_run",
    },
  ],
};

describe("run plan task progression", () => {
  test("planning requires a durable explicit decision and rejected plans remain blocked", () => {
    const plan = createRunPlan(input, "plan", "created");
    expect(plan.status).toBe("draft");
    expect(() => startPlanTask(plan)).toThrow("explicit approval");
    decideRunPlan(plan, false, "decided");
    const resumed = structuredClone(plan);
    expect(resumed).toMatchObject({ status: "rejected", decisionAt: "decided" });
    expect(() => startPlanTask(resumed)).toThrow("explicit approval");
    expect(() => decideRunPlan(resumed, true)).toThrow("Only a draft");
  });

  test("three tasks enforce dependencies, successful evidence and resume without restarting", () => {
    let plan = createRunPlan(input, "plan");
    decideRunPlan(plan, true);
    expect(() => startPlanTask(plan, "fix")).toThrow("inspect");
    expect(startPlanTask(plan).id).toBe("inspect");
    expect(() => verifyPlanTask(plan, "inspect", ["model-claim"])).toThrow("recorded");
    recordPlanToolResult(plan, "inspect", "read-1", "files_read", { text: "Source and tests" });
    verifyPlanTask(plan, "inspect", ["read-1"]);
    plan = JSON.parse(JSON.stringify(plan));
    expect(() => startPlanTask(plan, "inspect")).toThrow("already complete");
    expect(startPlanTask(plan).id).toBe("fix");
    recordPlanToolResult(plan, "fix", "patch-1", "files_patch", { text: "Changed order.py" });
    expect(() => verifyPlanTask(plan, "fix", ["patch-1"])).toThrow("files_read");
    expect(() => verifyPlanTask(plan, "fix", ["read-1"])).toThrow("recorded");
    recordPlanToolResult(plan, "fix", "read-2", "files_read", { text: "Corrected source" });
    verifyPlanTask(plan, "fix", ["patch-1", "read-2"]);
    expect(startPlanTask(plan).id).toBe("test");
    recordPlanToolResult(plan, "test", "test-fail", "shell_run", {
      text: "Exit 1",
      isError: true,
    });
    expect(() => verifyPlanTask(plan, "test", ["test-fail"])).toThrow("successful");
    recordPlanToolResult(plan, "test", "test-ok", "shell_run", { text: "Exit 0\nOK" });
    verifyPlanTask(plan, "test", ["test-ok"]);
    expect(unfinishedPlanTasks(plan)).toEqual([]);
    expect(() => currentPlanTask(plan)).toThrow("All plan tasks are complete");
  });

  test("idempotent evidence stays bounded and uncertain effects cannot verify completion", () => {
    const plan = createRunPlan(input, "build");
    startPlanTask(plan);
    const result = { text: "x".repeat(1000), outcomeUncertain: true };
    recordPlanToolResult(plan, "inspect", "call", "files_read", result);
    recordPlanToolResult(plan, "inspect", "call", "files_read", result);
    expect(plan.steps[0]!.evidence).toHaveLength(1);
    expect(plan.steps[0]!.evidence[0]!.summary).toHaveLength(300);
    expect(() => verifyPlanTask(plan, "inspect", ["call"])).toThrow("successful");
    expect(input.steps[0]).not.toHaveProperty("status");
  });

  test("rejects cycles, missing dependencies and metadata-only verification", () => {
    for (const edit of [
      (plan: RunPlanInput) => plan.steps[0]!.dependencies.push("test"),
      (plan: RunPlanInput) => plan.steps[0]!.dependencies.push("missing"),
      (plan: RunPlanInput) => (plan.steps[0]!.id = "../escape"),
      (plan: RunPlanInput) => (plan.steps[0]!.verificationTool = "plan_task"),
    ]) {
      const invalid = structuredClone(input);
      edit(invalid);
      expect(() => validateRunPlan(invalid)).toThrow();
    }
  });

  test("recovery context stays bounded, exposes evidence IDs and omits full result payloads", () => {
    const plan = createRunPlan(input, "build");
    startPlanTask(plan);
    recordPlanToolResult(plan, "inspect", "verified-read-id", "files_read", {
      text: "PRIVATE LARGE RESULT ".repeat(100),
    });
    const context = planContext(plan);
    expect(estimateTokens(context)).toBeLessThanOrEqual(1200);
    expect(context).toContain("verified-read-id:files_read");
    expect(context).not.toContain("PRIVATE LARGE RESULT");
    expect(context).toContain("deps=inspect");
  });
});
