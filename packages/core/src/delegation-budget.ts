import type { Session } from "./contracts.ts";

export interface DelegationReservation {
  tokens: number;
  settle(child?: Session): Promise<void>;
}

/** Reserve before launching a child; an uncertain child retains its full allocation. */
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
  parent.budgetSpent = spent + tokens;
  await save();
  let applied = false;
  let persisted = false;
  let saving: Promise<void> | undefined;
  return {
    tokens,
    async settle(child) {
      if (persisted) return;
      if (!applied) {
        applied = true;
        if (child) {
          const actual = child.usage.input + child.usage.output;
          const cost = Math.max(child.budgetSpent ?? actual, actual);
          parent.budgetSpent = (parent.budgetSpent ?? 0) - tokens + cost;
          parent.usage.input += child.usage.input;
          parent.usage.output += child.usage.output;
          parent.usage.cached += child.usage.cached;
        }
      }
      // A failed write can be retried without charging the child twice. Concurrent
      // callers share the same write and cannot observe a premature successful settle.
      saving ??= save()
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
