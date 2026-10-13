import { SqliteSessionStore } from "../store.ts";
import { print } from "../io.ts";
import { runCommand } from "./run.ts";
import type { CommandContext } from "./context.ts";
export async function sessionsCommand(
  action: string | undefined,
  rest: string[],
  context: CommandContext,
) {
  const { root } = context;
  if (action === "list") {
    const store = await SqliteSessionStore.open(root);
    try {
      await print(
        (await store.list(root)).map(({ id, status, ledger, usage, updatedAt }) => ({
          id,
          status,
          goal: ledger.goal,
          usage,
          updatedAt,
        })),
      );
    } finally {
      store.close();
    }
    return;
  } else if (action === "resume") {
    if (!rest[0]) throw new Error("Session ID required");
    await runCommand(rest.slice(1).join(" "), rest[0], context);
  } else throw new Error("Unknown sessions command");
}
