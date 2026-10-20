import { print } from "../io.ts";
import { runOptions } from "../run-options.ts";
import { decideTool, journalForRun, resolveTool, withRun } from "../workflows/run-controls.ts";
import type { CommandContext } from "./context.ts";

const actions = ["show", "tasks", "diff", "rollback", "approve", "deny", "resolve"];

export async function sessionControl(
  action: string | undefined,
  args: string[],
  context: CommandContext,
): Promise<boolean> {
  if (!action || !actions.includes(action)) return false;
  const [id, callId, resolution, attribution] = args;
  if (!id) throw new Error(`Run ID required: vcli sessions ${action} <run_id>`);
  const options = runOptions(context.values);
  if (action === "approve" || action === "deny") {
    if (!callId) throw new Error("Tool call ID required. Inspect vcli sessions show <run_id>.");
    await decideTool(context.root, id, callId, action === "approve", options);
    await print(`Decision saved. Continue: vcli sessions resume ${id}`);
    return true;
  }
  if (action === "resolve") {
    if (!callId || !["retry", "fail", "abort"].includes(resolution ?? ""))
      throw new Error(
        "Usage: vcli sessions resolve <run_id> <call_id> retry|fail|abort [attribute|discard]",
      );
    if (attribution && attribution !== "attribute" && attribution !== "discard")
      throw new Error("Choose attribute or discard for detected file changes.");
    await resolveTool(
      context.root,
      id,
      callId,
      resolution as "retry" | "fail" | "abort",
      attribution as "attribute" | "discard" | undefined,
      options,
    );
    await print(`Recovery decision saved for ${id}.`);
    return true;
  }
  await withRun(context.root, id, options, async (session) => {
    const journal = await journalForRun(context.root, session, options);
    if (action === "rollback") {
      if (
        Object.values(session.runState?.calls ?? {}).some((entry) =>
          ["started", "uncertain"].includes(entry.status),
        )
      )
        throw new Error("Inspect and explicitly resolve uncertain calls before rollback.");
      if (
        context.values.plan ||
        context.config.permission === "read-only" ||
        session.mode === "plan"
      )
        throw new Error("Plan/read-only mode denies rollback. Explicitly enable build mode first.");
      const summary = await journal.rollback(id);
      await print(
        context.values.json ? summary : `Restored ${summary.paths.length} files for run ${id}.`,
      );
      return;
    }
    if (action === "diff") {
      const summary = await journal.inspect(id);
      const uncertain = Object.values(session.runState?.calls ?? {}).find((entry) =>
        ["uncertain", "started"].includes(entry.status),
      );
      const detected =
        summary.pending || uncertain
          ? await journal.inspectUncertain(id, summary.pending?.callId ?? uncertain?.call.id)
          : undefined;
      await print(
        context.values.json
          ? { ...summary, detected }
          : summary.diff + (detected ? `\n\n${detected}` : ""),
      );
      return;
    }
    if (action === "tasks") {
      await print(session.plan?.steps ?? []);
      return;
    }
    const pending = Object.values(session.runState?.calls ?? {}).filter(
      (entry) => entry.status !== "complete",
    );
    await print({
      run_id: session.id,
      status: session.status,
      mode: session.mode,
      goal: session.ledger.goal,
      counters: session.runState?.counters,
      limits: session.runState?.limits,
      pending: pending.map(({ call, status, attempts, retrySafe }) => ({
        ...call,
        status,
        attempts,
        retrySafe,
      })),
      plan: session.plan,
      changes: await journal.inspect(id),
    });
  });
  return true;
}
