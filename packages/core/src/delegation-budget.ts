import type { Session } from "./contracts.ts";
import { initializeRunState, RunBudgetError, type RunLimits } from "./run-state.ts";

export interface DelegationReservation {
  id: string;
  tokens: number;
  runLimits: RunLimits;
  settle(child?: Session): Promise<void>;
}

function reserveCounters(parent: Session): RunLimits {
  const state = initializeRunState(parent);
  const remaining = (key: keyof RunLimits) => state.limits[key] - state.counters[key];
  for (const key of ["modelRequests", "toolCalls", "resultBytes"] as const)
    if (remaining(key) <= 0) throw new RunBudgetError(key);
  const limits: RunLimits = {
    modelRequests: Math.min(6, remaining("modelRequests")),
    toolCalls: Math.min(24, remaining("toolCalls")),
    sideEffects: 0, // Explorers have only local read tools.
    resultBytes: Math.min(8 * 1024 * 1024, remaining("resultBytes")),
  };
  for (const key of Object.keys(limits) as (keyof RunLimits)[]) state.counters[key] += limits[key];
  return limits;
}

/** Idempotent across restart: the settlement marker and actual charges share one saved snapshot. */
export async function settleDelegationReservation(
  parent: Session,
  id: string,
  child: Session | undefined,
  save: () => Promise<void>,
): Promise<void> {
  const state = parent.runState;
  const entry = state?.delegations?.[id];
  if (!state || !entry) throw new Error(`Delegation reservation not found: ${id}`);
  if (!entry.settled) {
    entry.settled = true;
    if (child) {
      const actual = child.usage.input + child.usage.output;
      const cost = Math.max(child.budgetSpent ?? actual, actual);
      parent.budgetSpent = (parent.budgetSpent ?? 0) - entry.tokens + cost;
      parent.usage.input += child.usage.input;
      parent.usage.output += child.usage.output;
      parent.usage.cached += child.usage.cached;
      entry.childSessionId = child.id;
      // A child without resource accounting retains the full durable allocation.
      if (child.runState)
        for (const key of Object.keys(entry.limits) as (keyof RunLimits)[]) {
          const used = child.runState.counters[key];
          if (Number.isSafeInteger(used) && used >= 0)
            state.counters[key] += used - entry.limits[key];
        }
    }
  }
  await save();
}

/** Reserve tokens and the four shared counters before launching an isolated explorer. */
export async function reserveDelegation(
  parent: Session,
  requested: number,
  limit: number | undefined,
  save: () => Promise<void>,
): Promise<DelegationReservation> {
  if (!Number.isSafeInteger(requested) || requested < 1024)
    throw new Error("Delegation requires at least 1024 tokens.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new Error("Task budget must be a nonnegative integer.");
  const spent = parent.budgetSpent ?? parent.usage.input + parent.usage.output;
  const tokens = Math.min(requested, limit === undefined ? requested : limit - spent);
  if (tokens < 1024) throw new Error("Insufficient task budget for delegation.");
  const runLimits = reserveCounters(parent);
  const id = crypto.randomUUID();
  parent.runState!.delegations ??= {};
  parent.runState!.delegations[id] = { tokens, limits: runLimits };
  parent.budgetSpent = spent + tokens;
  await save();
  let persisted = false;
  let saving: Promise<void> | undefined;
  return {
    id,
    tokens,
    runLimits,
    async settle(child) {
      if (persisted) return;
      // Concurrent callers await the same persistence; retries do not apply charges twice.
      saving ??= settleDelegationReservation(parent, id, child, save)
        .then(() => {
          persisted = true;
        })
        .finally(() => {
          saving = undefined;
        });
      await saving;
    },
  };
}
