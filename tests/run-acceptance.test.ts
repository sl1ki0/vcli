import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import { balanced, type RunPlanInput, type RuntimeEvent } from "@vcli/core";
import { createHarness } from "../apps/cli/src/harness.ts";
import type { Config } from "../apps/cli/src/config.ts";
import { decidePlan, journalForRun, withRun } from "../apps/cli/src/workflows/run-controls.ts";

const fixture = resolve(import.meta.dir, "../fixtures/order");
const plan: RunPlanInput = {
  goal: "Correct order totals without modifying tests",
  steps: [
    {
      id: "inspect",
      description: "Read the implementation and tests",
      dependencies: [],
      tools: ["files_list", "files_read"],
      verificationTool: "files_read",
      doneWhen: "Both files have been read",
    },
    {
      id: "fix",
      description: "Fix discount validation and calculation",
      dependencies: ["inspect"],
      tools: ["files_patch", "files_read"],
      verificationTool: "files_read",
      doneWhen: "The corrected source is read back",
    },
    {
      id: "test",
      description: "Run the unchanged tests through Bash",
      dependencies: ["fix"],
      tools: ["shell_run"],
      verificationTool: "shell_run",
      doneWhen: "python3 -m unittest -v exits successfully",
    },
  ],
  risks: ["Discounts outside 0–100 must raise ValueError"],
  assumptions: ["Python 3 is installed"],
  doneWhen: "Unchanged order tests pass and the run journal can restore original bytes",
};
const fixed =
  'def calculate_total(prices: list[float], discount_percent: float) -> float:\n    if not 0 <= discount_percent <= 100:\n        raise ValueError("discount_percent must be between 0 and 100")\n    return sum(prices) * (1 - discount_percent / 100)\n';
type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({
  id,
  name,
  args,
});

/** Scripted provider decisions exercise the production harness and real Bash, without paid APIs. */
test("ordinary harness plans, verifies three dependent tasks, resumes and rolls back the order fixture", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-order-run-")));
  const root = join(directory, "workspace");
  await cp(join(fixture, "workspace"), root, { recursive: true });
  const original = await readFile(join(root, "order.py"), "utf8");
  const tests = await readFile(join(root, "test_order.py"));
  const batches: Call[][] = [
    [call("publish", "plan_publish", plan as unknown as Record<string, unknown>)],
    [],
    [call("discover", "tools_search", { query: "plan_task shell_run" })],
    [call("start-inspect", "plan_task", { action: "start", taskId: "inspect" })],
    [
      call("list", "files_list", {}),
      call("read-order", "files_read", { path: "order.py" }),
      call("read-tests", "files_read", { path: "test_order.py" }),
    ],
    [
      call("complete-inspect", "plan_task", {
        action: "verify",
        taskId: "inspect",
        evidenceCallIds: ["read-order", "read-tests"],
      }),
    ],
    [call("start-fix", "plan_task", { action: "start", taskId: "fix" })],
    [call("patch", "files_patch", { path: "order.py", oldText: original, newText: fixed })],
    [call("check-patch", "files_read", { path: "order.py" })],
    [
      call("complete-fix", "plan_task", {
        action: "verify",
        taskId: "fix",
        evidenceCallIds: ["check-patch"],
      }),
    ],
    [call("start-test", "plan_task", { action: "start", taskId: "test" })],
    [call("bash-tests", "shell_run", { command: "python3 -m unittest -v", cwd: "." })],
    [
      call("complete-test", "plan_task", {
        action: "verify",
        taskId: "test",
        evidenceCallIds: ["bash-tests"],
      }),
    ],
    [],
    [],
  ];
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      const calls = batches[requests++] ?? [];
      const delta = calls.length
        ? {
            tool_calls: calls.map((entry, index) => ({
              index,
              id: entry.id,
              type: "function",
              function: { name: entry.name, arguments: JSON.stringify(entry.args) },
            })),
          }
        : { content: "Work recorded." };
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: calls.length ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } },
      ];
      return new Response(
        chunks.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const config: Config = {
    provider: "compatible",
    model: "fixture",
    baseURL: server.url.origin + "/v1",
    permission: "yolo",
    renderer: "off",
    context: { ...balanced, outputTokens: 1000 },
    mcpServers: [],
  };
  const options = {
    stateDirectory: join(directory, "state"),
    policyPath: join(fixture, "policy.json"),
    apiKey: "local-fixture-key",
  };
  const events: RuntimeEvent[] = [];
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(
      root,
      config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      undefined,
      { ...options, mode: "plan" },
    );
    const planned = await harness.run(
      "Fix order totals. Do not modify tests.",
      new AbortController().signal,
    );
    expect(planned.status).toBe("awaiting-plan");
    expect(planned.plan?.steps).toHaveLength(3);
    expect(
      events
        .filter((event) => event.type === "tool-start")
        .every((event) => event.data.kind === "read"),
    ).toBe(true);
    expect(await readFile(join(root, "order.py"), "utf8")).toBe(original);
    const planningCounters = { ...planned.runState!.counters };
    await harness.close();
    harness = undefined;
    await decidePlan(root, planned.id, true, options);
    harness = await createHarness(
      root,
      config,
      createArchitectureService(),
      (event) => {
        events.push(event);
      },
      undefined,
      { ...options, mode: "build", resumeId: planned.id },
    );
    const completed = await harness.run("", new AbortController().signal, planned.id);
    expect(completed.status).toBe("complete");
    expect(completed.plan?.steps.map((step) => step.status)).toEqual([
      "complete",
      "complete",
      "complete",
    ]);
    expect(completed.runState!.calls["bash-tests"]?.call.taskId).toBe("test");
    expect(completed.runState!.calls["bash-tests"]?.result?.isError).toBe(false);
    expect(completed.runState!.calls["bash-tests"]?.result?.output).toContain("OK");
    expect(completed.runState!.counters.modelRequests).toBeGreaterThan(
      planningCounters.modelRequests,
    );
    expect(await readFile(join(root, "test_order.py"))).toEqual(tests);
    expect(
      completed.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "bash-tests",
      ),
    ).toBe(true);
    expect(
      completed.chat?.some(
        (message) => message.id.startsWith("plan:") && message.text.includes("3/3 verified"),
      ),
    ).toBe(true);
    const beforeResume = completed.runState!.counters.toolCalls;
    await harness.close();
    harness = undefined;
    harness = await createHarness(root, config, createArchitectureService(), undefined, undefined, {
      ...options,
      mode: "build",
      resumeId: planned.id,
    });
    const resumed = await harness.run("", new AbortController().signal, planned.id);
    expect(resumed.runState!.counters.toolCalls).toBe(beforeResume);
    expect(
      events.filter((event) => event.type === "tool-start" && event.data.name === "shell_run"),
    ).toHaveLength(1);
    await harness.close();
    harness = undefined;
    await withRun(root, planned.id, options, async (saved) => {
      const journal = await journalForRun(root, saved, options);
      expect((await journal.inspect(saved.id)).diff).toContain("discount_percent must be between");
      await journal.rollback(saved.id);
    });
    expect(await readFile(join(root, "order.py"), "utf8")).toBe(original);
    expect(await readFile(join(root, "test_order.py"))).toEqual(tests);
  } finally {
    await harness?.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
