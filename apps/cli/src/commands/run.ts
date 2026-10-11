import type { RuntimeEvent } from "@vcli/core";
import type { Config } from "../config.ts";
import { createHarness } from "../harness.ts";
import { SqliteSessionStore } from "../store.ts";
import { print, confirm, writeOutput } from "../io.ts";
import type { CommandContext } from "./context.ts";
export async function runCommand(
  prompt: string,
  resume: string | undefined,
  context: CommandContext,
) {
  const { root, config, architecture, values } = context;
  if (!resume && !prompt) throw new Error("Task required: vcli run <task>");
  if (resume && !config.model) {
    const store = await SqliteSessionStore.open(root);
    const session = await store.get(resume);
    store.close();
    if (!session) throw new Error("Session not found");
    config.provider = session.provider as Config["provider"];
    config.model = session.model;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const emit = async (event: RuntimeEvent) => {
    if (values.json) await print(JSON.stringify(event));
    else if (event.type === "text") await writeOutput(String(event.data.text));
    else if (["tool-start", "status"].includes(event.type))
      await writeOutput(`\n${event.data.name ?? event.data.status}\n`, "stderr");
  };
  const harness = await createHarness(root, config, architecture, emit, (tool, args) =>
    confirm(tool, args, controller.signal),
  );
  process.once("SIGINT", cancel);
  try {
    const session = await harness.run(prompt, controller.signal, resume);
    if (!values.json)
      await print(
        `\nSession ${session.id} · ${session.status} · ${session.usage.input + session.usage.output} tokens`,
      );
    if (session.status !== "complete") process.exitCode = session.status === "aborted" ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
    await harness.close();
  }
  return;
}
