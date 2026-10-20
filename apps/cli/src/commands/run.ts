import type { RuntimeEvent } from "@vcli/core";
import type { Config } from "../config.ts";
import { createHarness } from "../harness.ts";
import { SqliteSessionStore } from "../store.ts";
import { print, confirm, writeOutput } from "../io.ts";
import type { CommandContext } from "./context.ts";
import { runOptions, storeOptions } from "../run-options.ts";
import { decidePlan } from "../workflows/run-controls.ts";
export async function runCommand(
  prompt: string,
  resume: string | undefined,
  context: CommandContext,
) {
  const { root, config, architecture, values } = context;
  let mode: "build" | "plan" = values.plan ? "plan" : "build";
  if (!resume && !prompt) throw new Error("Task required: vcli run <task>");
  if (resume) {
    const store = await SqliteSessionStore.open(root, storeOptions(values));
    const session = await store.get(resume);
    store.close();
    if (!session) throw new Error("Session not found");
    if (!config.model) {
      config.provider = session.provider as Config["provider"];
      config.model = session.model;
    }
    if (!values.plan && !values.build) mode = session.mode ?? "build";
    if (values.build && session.plan?.status === "draft")
      await decidePlan(root, session.id, true, runOptions(values));
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const emit = async (event: RuntimeEvent) => {
    if (values.json) await print(JSON.stringify(event));
    else if (event.type === "text") await writeOutput(String(event.data.text));
    else if (["tool-start", "status"].includes(event.type))
      await writeOutput(`\n${event.data.name ?? event.data.status}\n`, "stderr");
  };
  const harness = await createHarness(
    root,
    config,
    architecture,
    emit,
    process.stdin.isTTY && process.stderr.isTTY
      ? (tool, args) => confirm(tool, args, controller.signal)
      : undefined,
    { mode, ...runOptions(values), resumeId: resume },
  );
  process.once("SIGINT", cancel);
  try {
    const session = await harness.run(prompt, controller.signal, resume);
    if (!values.json)
      await print(
        `\nSession ${session.id} · ${session.status} · ${session.usage.input + session.usage.output} tokens`,
      );
    if (session.status !== "complete") {
      process.exitCode = ["awaiting-plan", "awaiting-approval"].includes(session.status)
        ? 0
        : session.status === "aborted"
          ? 130
          : 1;
      if (
        !values.json &&
        ["awaiting-approval", "awaiting-plan", "uncertain"].includes(session.status)
      )
        await print(
          `Inspect: vcli sessions show ${session.id}\nResume: vcli sessions resume ${session.id}`,
        );
    }
  } finally {
    process.off("SIGINT", cancel);
    await harness.close();
  }
  return;
}
