import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ManagedRuntime, taskChecklist, type ManagedRun, type RunLimits } from "@vcli/core";
import { createProvider } from "@vcli/providers";
import { HomeworkPolicy } from "../workflows/homework/policy.ts";
import { HomeworkExecutor } from "../workflows/homework/executor.ts";
import { HomeworkStore } from "../workflows/homework/store.ts";
import { HomeworkJournal } from "../workflows/homework/journal.ts";
import { homeworkDemo } from "../workflows/homework/demo.ts";
import { print } from "../io.ts";

const HELP = `vcli homework — durable policy-controlled coding workflow

start --workspace PATH --policy PATH [--state PATH] [--mode safe|auto] [--plan] [--demo] PROMPT
resume RUN_ID [--demo]
plan RUN_ID approve|reject [--demo]
approve RUN_ID allow|deny [--demo]
resolve RUN_ID CALL_ID fail|retry|abort [--adopt] [--demo]
status|tasks|diff|rollback RUN_ID

Use the same --state PATH (SQLite file outside workspace) for each command.
Budget flags for start: --model-requests N --tool-calls N --side-effects N --result-bytes N
Real model: OPENAI_MODEL, OPENAI_BASE_URL, OPENAI_API_KEY; --demo is offline.
Policy and state must be outside workspace. safe is the default.
`;

async function externalState(path: string, root?: string): Promise<string> {
  const partBefore = root ? relative(root, path) : undefined;
  if (
    partBefore !== undefined &&
    (partBefore === "" ||
      (!isAbsolute(partBefore) && partBefore !== ".." && !partBefore.startsWith(`..${sep}`)))
  )
    throw new Error("Run state must be outside the mutable workspace.");
  // Never let SQLite follow a state-file or ancestor link into the workspace.
  let current: string = sep;
  for (const component of path.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new Error("Run state cannot use linked paths.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = await lstat(path + suffix);
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Run state and SQLite sidecars must be regular unlinked files.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(path));
  const canonical = resolve(parent, basename(path));
  const part = root ? relative(root, canonical) : undefined;
  if (
    part !== undefined &&
    (part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)))
  )
    throw new Error("Run state must be outside the mutable workspace.");
  return canonical;
}
function summary(run: ManagedRun): string {
  const pending = run.batch[run.batchIndex];
  const last = run.messages
    .filter((message) => message.role === "assistant" && message.text)
    .at(-1)?.text;
  return [
    `run_id: ${run.id}`,
    `status: ${run.status}`,
    `phase: ${run.phase}; mode: ${run.mode}`,
    `budget: ${JSON.stringify(run.spent)} / ${JSON.stringify(run.limits)}`,
    taskChecklist(run),
    run.status === "waiting-plan" ? JSON.stringify(run.plan, null, 2) : "",
    run.status === "waiting-approval" && pending ? `approval: ${JSON.stringify(pending)}` : "",
    ...run.calls
      .filter((entry) => entry.state === "started" || entry.state === "uncertain")
      .map(
        (entry) =>
          `uncertain: ${entry.call.id} (${entry.call.name}, attempt ${entry.attempts}); inspect diff, then resolve with fail/retry/abort`,
      ),
    run.error ?? "",
    last ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
export async function homeworkCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      workspace: { type: "string" },
      policy: { type: "string" },
      state: { type: "string" },
      mode: { type: "string" },
      plan: { type: "boolean" },
      demo: { type: "boolean" },
      adopt: { type: "boolean" },
      "model-requests": { type: "string" },
      "tool-calls": { type: "string" },
      "side-effects": { type: "string" },
      "result-bytes": { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    await print(HELP);
    return;
  }
  const [action, id, decision, extra] = positionals;
  if (
    ![
      "start",
      "resume",
      "plan",
      "approve",
      "resolve",
      "status",
      "tasks",
      "diff",
      "rollback",
    ].includes(action!)
  )
    throw new Error("Unknown homework command. Use homework --help.");
  const statePath = resolve(values.state ?? resolve(homedir(), ".vcli", "homework.sqlite"));
  let store: HomeworkStore;
  let saved: ManagedRun | undefined;
  if (action === "start") {
    if (!values.workspace || !values.policy)
      throw new Error("start requires --workspace and --policy.");
    if (values.mode && values.mode !== "safe" && values.mode !== "auto")
      throw new Error("Choose safe or auto mode.");
    const root = await realpath(resolve(values.workspace));
    store = new HomeworkStore(await externalState(statePath, root));
  } else store = new HomeworkStore(await externalState(statePath));
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("Interrupted by user; resume the persisted run."));
  process.once("SIGINT", cancel);
  try {
    if (action !== "start") {
      if (!id) throw new Error("run_id is required.");
      saved = await store.get(id);
      await externalState(statePath, saved.root);
    }
    const policy = await HomeworkPolicy.open(
      saved?.root ?? resolve(values.workspace!),
      saved?.policyPath ?? resolve(values.policy!),
    );
    const journal = new HomeworkJournal(policy);
    const provider =
      values.demo || ["status", "tasks", "diff", "rollback"].includes(action!)
        ? homeworkDemo()
        : saved?.provider?.id === "homework-demo"
          ? (() => {
              throw new Error("Resume this demo with --demo; no implicit provider switch.");
            })()
          : createProvider(
              {
                provider: "compatible",
                model: process.env.OPENAI_MODEL || "offline-inspection",
                baseURL: process.env.OPENAI_BASE_URL,
                apiKey: process.env.OPENAI_API_KEY,
              },
              {
                // The managed budget counts each network request; retries require another durable reservation.
                sleep: async () => {
                  throw new Error("Model request failed; use resume for a budgeted retry.");
                },
              },
            );
    if (
      !["status", "tasks", "diff", "rollback"].includes(action!) &&
      !values.demo &&
      !process.env.OPENAI_MODEL
    )
      throw new Error("Set OPENAI_MODEL explicitly, or use --demo for offline verification.");
    const executor = new HomeworkExecutor(policy);
    const runtime = new ManagedRuntime({
      provider,
      executor,
      journal,
      store,
      instructions: async () => {
        let remaining = 6000;
        const sections: string[] = [];
        for (const path of ["AGENTS.md", "CLAUDE.md", ".vcli/MEMORY.md"]) {
          if (remaining < 100) break;
          try {
            const result = await executor.execute(
              { id: "instructions", name: "read_file", arguments: { path } },
              remaining - 64,
              controller.signal,
            );
            if (result.isError) continue;
            const section = `\n--- ${path} ---\n${result.text}`;
            remaining -= Buffer.byteLength(section);
            sections.push(section);
          } catch {
            /* Missing or policy-denied instructions are not loaded. */
          }
        }
        return sections.join("");
      },
    });
    await store.withLock(saved?.id ?? "start", async () => {
      // Reload after acquiring the lock; a concurrent command may have changed the revision.
      const run = saved
        ? await store.get(saved.id)
        : await runtime.create({
            id: randomUUID(),
            root: policy.root,
            policyPath: policy.policyPath,
            goal:
              positionals.slice(1).join(" ") ||
              "Fix the order calculation so the original tests pass. Do not change tests. Find files, fix code, run tests.",
            mode: values.mode === "auto" ? "auto" : "safe",
            plan: values.plan,
            limits: Object.fromEntries(
              (
                [
                  ["model-requests", "modelRequests"],
                  ["tool-calls", "toolCalls"],
                  ["side-effects", "sideEffects"],
                  ["result-bytes", "resultBytes"],
                ] as const
              )
                .filter(([flag]) => values[flag] !== undefined)
                .map(([flag, name]) => {
                  if (!/^\d+$/.test(values[flag]!)) throw new Error(`Invalid ${flag} limit.`);
                  return [name, Number(values[flag])];
                }),
            ) as Partial<RunLimits>,
          });
      if (action === "start") await print(`run_id: ${run.id}`);
      if (action === "status") {
        await print(summary(run));
        return;
      }
      if (action === "tasks") {
        await print(taskChecklist(run));
        return;
      }
      if (action === "diff") {
        await print(await journal.inspect(run));
        return;
      }
      if (action === "rollback") {
        if (run.status === "rolled-back") {
          await print("Already rolled back.\n" + summary(run));
          return;
        }
        if (
          run.status === "uncertain" ||
          run.calls.some((call) => ["started", "uncertain"].includes(call.state))
        )
          throw new Error(
            "Resolve uncertain calls and explicitly attribute their changes before rollback.",
          );
        run.status = "rolling-back";
        await store.save(run);
        try {
          await journal.rollback(run);
        } catch (error) {
          run.status = "rolling-back";
          run.error = "Rollback did not finish; inspect the tree before further actions.";
          await store.save(run);
          throw error;
        }
        run.status = "rolled-back";
        await store.save(run);
        await print(summary(run));
        return;
      }
      if (action === "plan") {
        if (decision !== "approve" && decision !== "reject")
          throw new Error("Choose approve or reject.");
        await runtime.approvePlan(run, decision);
      }
      if (action === "approve") {
        if (decision !== "allow" && decision !== "deny") throw new Error("Choose allow or deny.");
        await runtime.approveAction(run, decision);
      }
      if (action === "resolve") {
        if (!decision || !["fail", "retry", "abort"].includes(extra!))
          throw new Error("resolve requires CALL_ID fail|retry|abort.");
        await runtime.resolve(run, decision, extra as "fail" | "retry" | "abort", values.adopt);
      }
      if (action === "resume") await runtime.resumeFailure(run);
      await runtime.advance(run, controller.signal);
      await print(summary(run));
      if (run.status === "uncertain") await print(await journal.inspect(run));
      if (["failed", "budget"].includes(run.status)) process.exitCode = 1;
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    store.close();
  }
}
