import {
  decideRunPlan,
  resolveRunApproval,
  resolveRunUncertainty,
  type Session,
  type UncertainResolution,
} from "@vcli/core";
import type { HarnessOptions } from "../harness.ts";
import { SqliteSessionStore } from "../store.ts";
import { RunJournal } from "./journal.ts";
import { ProjectPolicy } from "./policy.ts";
import { savePlan, syncPlanChat } from "./plans.ts";

/** Read and decide durable state without constructing a provider or invoking inference. */
export async function withRun<T>(
  root: string,
  id: string,
  options: Pick<HarnessOptions, "stateDirectory">,
  action: (session: Session, store: SqliteSessionStore) => Promise<T>,
): Promise<T> {
  const store = await SqliteSessionStore.open(root, { directory: options.stateDirectory });
  try {
    const session = await store.get(id);
    if (!session || session.root !== root) throw new Error(`Run not found in this project: ${id}`);
    return await action(session, store);
  } finally {
    store.close();
  }
}

export async function journalForRun(root: string, session: Session, options: HarnessOptions = {}) {
  if (
    session.executionPolicy &&
    options.policyPath &&
    options.policyPath !== session.executionPolicy.path
  )
    throw new Error("Run operations must retain its bound policy file.");
  const policy = await ProjectPolicy.load(
    root,
    session.executionPolicy?.path ?? options.policyPath,
    options,
  );
  return new RunJournal(root, { ...options, policy });
}

export async function decidePlan(
  root: string,
  id: string,
  approved: boolean,
  options: HarnessOptions = {},
): Promise<Session> {
  return withRun(root, id, options, async (session, store) => {
    if (!session.plan) throw new Error("No structured plan is saved for this run.");
    decideRunPlan(session.plan, approved);
    session.mode = approved ? "build" : "plan";
    session.status = approved ? "running" : "awaiting-plan";
    syncPlanChat(session);
    await store.save(session);
    await savePlan(root, session, { directory: options.stateDirectory });
    return session;
  });
}

export async function decideTool(
  root: string,
  id: string,
  callId: string,
  approved: boolean,
  options: HarnessOptions = {},
): Promise<void> {
  await withRun(root, id, options, async (session, store) => {
    await resolveRunApproval(session, callId, approved, () => store.save(session));
  });
}

export async function resolveTool(
  root: string,
  id: string,
  callId: string,
  resolution: UncertainResolution,
  attribution: "attribute" | "discard" | undefined,
  options: HarnessOptions = {},
): Promise<void> {
  await withRun(root, id, options, async (session, store) => {
    const journal = await journalForRun(root, session, options);
    const pending = (await journal.inspect(id)).pending;
    const entry = session.runState?.calls[callId];
    if (
      (pending ||
        (entry && entry.kind !== "read" && ["uncertain", "started"].includes(entry.status))) &&
      !attribution
    )
      throw new Error(
        "Inspect sessions diff first, then choose attribute or discard for the detected changes.",
      );
    if (pending?.callId === callId && !session.runState?.calls[callId]) {
      if (resolution === "retry")
        throw new Error(
          "Resolve the interrupted rollback with fail, then issue rollback again after inspecting its diff.",
        );
      await journal.resolvePending(id, callId, attribution === "attribute");
      if (resolution === "abort") {
        if (session.runState) session.runState.aborted = true;
        session.status = "failed";
      }
      await store.save(session);
      return;
    }
    await resolveRunUncertainty(session, callId, resolution, {
      save: () => store.save(session),
      resolveEffects: () => journal.resolvePending(id, callId, attribution === "attribute"),
    });
  });
}
