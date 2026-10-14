import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ManagedRun } from "@vcli/core";
import { HomeworkStore } from "../apps/cli/src/workflows/homework/store.ts";

const cli = resolve(import.meta.dir, "../apps/cli/src/index.ts");
const source = resolve(import.meta.dir, "../fixtures/homework");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli homework cli-")));
  directories.push(directory);
  const root = join(directory, "workspace");
  const policy = join(directory, "policy.json");
  const state = join(directory, "runs.sqlite");
  await cp(join(source, "workspace"), root, { recursive: true });
  await cp(join(source, "policy.json"), policy);
  return { directory, root, policy, state };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(w: Fixture, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, "homework", ...args, "--state", w.state], {
    cwd: w.root,
    env: {
      ...process.env,
      OPENAI_MODEL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
      ...environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
function start(w: Fixture, flags: string[] = []) {
  return run(w, [
    "start",
    "--workspace",
    w.root,
    "--policy",
    w.policy,
    "--demo",
    ...flags,
    "Fix the order calculation so the original tests pass. Do not change tests. Find files, fix code, run tests.",
  ]);
}
function runId(stdout: string) {
  const id = stdout.match(/^run_id: ([a-f0-9-]+)$/m)?.[1];
  expect(id).toBeDefined();
  return id!;
}
async function saved(w: Fixture, id: string): Promise<ManagedRun> {
  const store = new HomeworkStore(w.state);
  try {
    return await store.get(id);
  } finally {
    store.close();
  }
}
const hash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

describe("public homework CLI", () => {
  test("offline agent fixes supplied order through real Bash, preserves tests, and rolls back after restart", async () => {
    const w = await fixture();
    const original = await readFile(join(w.root, "order.py"));
    const testHash = hash(await readFile(join(w.root, "test_order.py")));
    const started = await start(w, ["--mode", "auto"]);
    expect(started.code).toBe(0);
    expect(started.stderr).toBe("");
    expect(started.stdout).toContain("status: complete");
    const id = runId(started.stdout);
    const complete = await saved(w, id);
    expect(complete.calls.filter((entry) => entry.call.name === "Bash")).toHaveLength(1);
    const bash = complete.calls.find((entry) => entry.call.name === "Bash")!;
    expect(bash.call.arguments).toEqual({ command: "python3 -m unittest -v", cwd: "." });
    expect(bash.result?.exitCode).toBe(0);
    expect(bash.result?.isError).toBe(false);
    expect(bash.result?.text).toContain("Ran 2 tests");
    expect(bash.result?.text).toContain("OK");
    expect(hash(await readFile(join(w.root, "test_order.py")))).toBe(testHash);
    expect(complete.journal.changes.map((change) => change.path)).toEqual(["order.py"]);
    const diff = await run(w, ["diff", id]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("--- a/order.py");
    expect(diff.stdout).toContain("+    if not 0 <= discount_percent <= 100:");
    const resumed = await run(w, ["resume", id, "--demo"]);
    expect(resumed.code).toBe(0);
    expect((await saved(w, id)).spent).toEqual(complete.spent);
    expect((await saved(w, id)).calls).toHaveLength(complete.calls.length);
    const rollback = await run(w, ["rollback", id]);
    expect(rollback.code).toBe(0);
    expect(rollback.stdout).toContain("status: rolled-back");
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
    expect(hash(await readFile(join(w.root, "test_order.py")))).toBe(testHash);
    expect((await run(w, ["diff", id])).stdout).toContain("--- a/order.py");
  }, 20_000);

  test("safe Plan Mode persists three dependent tasks and separately approves write and Bash", async () => {
    const w = await fixture();
    const original = await readFile(join(w.root, "order.py"));
    const started = await start(w, ["--mode", "safe", "--plan"]);
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("status: waiting-plan");
    const id = runId(started.stdout);
    const planning = await saved(w, id);
    expect(planning.plan?.steps).toHaveLength(3);
    expect(
      planning.calls.some((entry) =>
        ["write_file", "delete_file", "Bash"].includes(entry.call.name),
      ),
    ).toBe(false);
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
    expect((await run(w, ["resume", id, "--demo"])).stdout).toContain("waiting-plan");
    expect((await saved(w, id)).spent).toEqual(planning.spent);
    const approved = await run(w, ["plan", id, "approve", "--demo"]);
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain("status: waiting-approval");
    expect(approved.stdout).toContain('"name":"write_file"');
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
    const wrote = await run(w, ["approve", id, "allow", "--demo"]);
    expect(wrote.code).toBe(0);
    expect(wrote.stdout).toContain("status: waiting-approval");
    expect(wrote.stdout).toContain('"name":"Bash"');
    expect(
      (await saved(w, id)).calls
        .filter((entry) => entry.call.name === "Bash")
        .every((entry) => entry.state === "pending"),
    ).toBe(true);
    const finished = await run(w, ["approve", id, "allow", "--demo"]);
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain("status: complete");
    const complete = await saved(w, id);
    expect(complete.planDecision).toBe("approve");
    expect(
      complete.plan?.steps.every((task) => task.state === "complete" && Boolean(task.evidence)),
    ).toBe(true);
    expect(
      complete.calls
        .filter(
          (entry) => entry.phase === "execution" && !["submit_plan"].includes(entry.call.name),
        )
        .every((entry) => Boolean(entry.taskId)),
    ).toBe(true);
    const tasks = await run(w, ["tasks", id]);
    expect(tasks.code).toBe(0);
    expect(tasks.stdout.match(/^\[x\]/gm)).toHaveLength(3);
    const after = await run(w, ["resume", id, "--demo"]);
    expect(after.code).toBe(0);
    expect((await saved(w, id)).calls).toHaveLength(complete.calls.length);
  }, 20_000);

  test("a durable refusal returns a tool error without writing or starting Bash", async () => {
    const w = await fixture();
    const original = await readFile(join(w.root, "order.py"));
    const started = await start(w, ["--mode", "safe"]);
    const id = runId(started.stdout);
    expect(started.stdout).toContain("status: waiting-approval");
    const denied = await run(w, ["approve", id, "deny", "--demo"]);
    expect(denied.code).toBe(0);
    const complete = await saved(w, id);
    const write = complete.calls.find((entry) => entry.call.name === "write_file")!;
    expect(write.approval).toBe("deny");
    expect(write.attempts).toBe(0);
    expect(write.result?.isError).toBe(true);
    expect(write.result?.text).toContain("Human declined");
    expect(
      complete.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === write.call.id &&
          message.text.includes("Human declined"),
      ),
    ).toBe(true);
    expect(complete.calls.some((entry) => entry.call.name === "Bash")).toBe(false);
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
  }, 15_000);

  test("rejected plans never mutate, and a zero inference budget survives resume", async () => {
    const w = await fixture();
    const original = await readFile(join(w.root, "order.py"));
    const planned = await start(w, ["--mode", "auto", "--plan"]);
    const planId = runId(planned.stdout);
    const rejected = await run(w, ["plan", planId, "reject", "--demo"]);
    expect(rejected.code).toBe(0);
    expect(rejected.stdout).toContain("status: rejected");
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
    const budget = await start(w, ["--mode", "auto", "--model-requests", "0"]);
    expect(budget.code).toBe(1);
    expect(budget.stdout).toContain("status: budget");
    const id = runId(budget.stdout);
    const before = await saved(w, id);
    expect(before.spent.modelRequests).toBe(0);
    expect(before.calls).toEqual([]);
    expect((await run(w, ["resume", id, "--demo"])).code).toBe(1);
    expect((await saved(w, id)).spent).toEqual(before.spent);
    expect(await readFile(join(w.root, "order.py"))).toEqual(original);
  }, 20_000);

  test("rollback detects a later human edit and external policy/state placement is enforced", async () => {
    const w = await fixture();
    const started = await start(w, ["--mode", "auto"]);
    const id = runId(started.stdout);
    await writeFile(join(w.root, "order.py"), "# external edit\n");
    const rollback = await run(w, ["rollback", id]);
    expect(rollback.code).toBe(1);
    expect(rollback.stderr).toContain("Rollback conflict");
    expect(await readFile(join(w.root, "order.py"), "utf8")).toBe("# external edit\n");
    await cp(w.policy, join(w.root, "policy.json"));
    const internalPolicy = await run(w, [
      "start",
      "--workspace",
      w.root,
      "--policy",
      join(w.root, "policy.json"),
      "--mode",
      "auto",
      "--demo",
    ]);
    expect(internalPolicy.code).toBe(1);
    expect(internalPolicy.stderr).toContain("policy must be outside");
    const internalState = { ...w, state: join(w.root, "state.sqlite") };
    const stateDenied = await start(internalState, ["--mode", "auto"]);
    expect(stateDenied.code).toBe(1);
    expect(stateDenied.stderr).toContain("state must be outside");
    expect(await Bun.file(internalState.state).exists()).toBe(false);
  }, 20_000);

  test("compatible model selects multiple tools and receives original tool_call_id results", async () => {
    const w = await fixture();
    const testHash = hash(await readFile(join(w.root, "test_order.py")));
    const requests: Record<string, unknown>[] = [];
    const failures: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const turn = requests.push(body) - 1;
          expect(body.model).toBe("fixture-model");
          if (turn === 0) {
            const tools = body.tools as {
              function: { name: string; parameters: Record<string, unknown>; description: string };
            }[];
            for (const name of ["list_files", "read_file", "write_file", "Bash"]) {
              const schema = tools.find((tool) => tool.function.name === name)?.function;
              expect(schema?.description).toBeTruthy();
              expect(schema?.parameters.type).toBe("object");
            }
          }
          const messages = body.messages as {
            role: string;
            tool_call_id?: string;
            content?: string;
          }[];
          if (turn === 1)
            expect(
              messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.tool_call_id === "model-read-order" &&
                  message.content?.includes("sum(prices) - discount_percent"),
              ),
            ).toBe(true);
          if (turn === 3)
            expect(
              messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.tool_call_id === "model-bash" &&
                  message.content?.includes("Ran 2 tests"),
              ),
            ).toBe(true);
          const calls =
            turn === 0
              ? [
                  { id: "model-list", name: "list_files", args: { path: "." } },
                  { id: "model-read-order", name: "read_file", args: { path: "order.py" } },
                  { id: "model-read-tests", name: "read_file", args: { path: "test_order.py" } },
                ]
              : turn === 1
                ? [
                    {
                      id: "model-write",
                      name: "write_file",
                      args: {
                        path: "order.py",
                        content:
                          'def calculate_total(prices: list[float], discount_percent: float) -> float:\n    if discount_percent < 0 or discount_percent > 100:\n        raise ValueError("invalid discount")\n    return sum(prices) * (100 - discount_percent) / 100\n',
                      },
                    },
                  ]
                : turn === 2
                  ? [
                      {
                        id: "model-bash",
                        name: "Bash",
                        args: { command: "python3 -m unittest -v", cwd: "." },
                      },
                    ]
                  : [];
          const delta = {
            content: calls.length ? "" : "Original tests pass after the order fix.",
            ...(calls.length
              ? {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                }
              : {}),
          };
          return new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        } catch (error) {
          failures.push(error);
          return new Response("Local model fixture failed", { status: 400 });
        }
      },
    });
    try {
      const result = await run(
        w,
        [
          "start",
          "--workspace",
          w.root,
          "--policy",
          w.policy,
          "--mode",
          "auto",
          "Fix the order calculation; do not change tests; run tests.",
        ],
        {
          OPENAI_MODEL: "fixture-model",
          OPENAI_API_KEY: "local-fixture",
          OPENAI_BASE_URL: `${server.url.origin}/v1`,
        },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("status: complete");
      const complete = await saved(w, runId(result.stdout));
      expect(complete.spent.modelRequests).toBe(4);
      expect(complete.calls.map((entry) => entry.call.id)).toEqual([
        "model-list",
        "model-read-order",
        "model-read-tests",
        "model-write",
        "model-bash",
      ]);
      expect(
        complete.calls.every((entry) => entry.state === "complete" && !entry.result?.isError),
      ).toBe(true);
      expect(hash(await readFile(join(w.root, "test_order.py")))).toBe(testHash);
      expect(requests).toHaveLength(4);
      expect(failures).toEqual([]);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
