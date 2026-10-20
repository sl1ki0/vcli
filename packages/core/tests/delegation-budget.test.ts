import { expect, test } from "bun:test";
import { reserveDelegation, type Session } from "../src/index.ts";

function session(spent = 0): Session {
  return {
    id: "parent",
    root: "/project",
    provider: "fixture",
    model: "fixture",
    status: "running",
    createdAt: "now",
    updatedAt: "now",
    messages: [],
    ledger: {
      goal: "Inspect",
      constraints: [],
      decisions: [],
      pending: [],
      touchedPaths: [],
      verification: [],
    },
    usage: { input: 0, output: 0, cached: 0 },
    budgetSpent: spent,
  };
}

test("concurrent reservations never allocate more than the remaining parent budget", async () => {
  const parent = session(2000);
  const writes: number[] = [];
  const save = async () => {
    writes.push(parent.budgetSpent!);
    await Promise.resolve();
  };
  const first = reserveDelegation(parent, 6000, 10000, save);
  const second = reserveDelegation(parent, 6000, 10000, save);
  await expect(reserveDelegation(parent, 4000, 10000, save)).rejects.toThrow("Insufficient");
  const reservations = await Promise.all([first, second]);
  expect(reservations.map((reservation) => reservation.tokens)).toEqual([6000, 2000]);
  expect(writes).toEqual([8000, 10000]);
  const child = session(700);
  child.usage = { input: 500, output: 200, cached: 100 };
  await Promise.all(reservations.map((reservation) => reservation.settle(child)));
  expect(parent.budgetSpent).toBe(3400);
  expect(parent.usage).toEqual({ input: 1000, output: 400, cached: 200 });
  await reservations[0]!.settle(child);
  expect(parent.budgetSpent).toBe(3400);
});

test("unknown child outcome and missing provider usage retain durable charges across resume", async () => {
  const parent = session(1200);
  let snapshot = "";
  const save = async () => {
    snapshot = JSON.stringify(parent);
  };
  const unknown = await reserveDelegation(parent, 4000, 10000, save);
  await unknown.settle();
  const measured = await reserveDelegation(parent, 4000, 10000, save);
  const child = session(3100); // Provider failed before reporting usage.
  child.status = "aborted";
  await measured.settle(child);
  const resumed = JSON.parse(snapshot) as Session;
  expect(resumed.budgetSpent).toBe(8300);
  expect(resumed.usage.input + resumed.usage.output).toBe(0);
  const final = await reserveDelegation(resumed, 4000, 10000, async () => {});
  expect(final.tokens).toBe(1700);
  await expect(reserveDelegation(resumed, 4000, 10000, async () => {})).rejects.toThrow(
    "Insufficient",
  );
});

test("settlement retries failed persistence without duplicate charges and concurrent callers await it", async () => {
  const parent = session();
  let writes = 0;
  let retryWrite: (() => void) | undefined;
  const reservation = await reserveDelegation(parent, 4000, 10000, async () => {
    writes++;
    if (writes === 2) throw new Error("Disk unavailable");
    if (writes === 3)
      await new Promise<void>((resolve) => {
        retryWrite = resolve;
      });
  });
  const child = session(600);
  child.usage = { input: 400, output: 200, cached: 50 };
  await expect(reservation.settle(child)).rejects.toThrow("Disk unavailable");
  let completions = 0;
  const first = reservation.settle(child).then(() => {
    completions++;
  });
  const second = reservation.settle(child).then(() => {
    completions++;
  });
  await Promise.resolve();
  expect(completions).toBe(0);
  expect(writes).toBe(3);
  expect(parent.usage.input).toBe(400);
  retryWrite!();
  await Promise.all([first, second]);
  expect(completions).toBe(2);
  expect(parent.budgetSpent).toBe(600);
});

test("child actual usage cannot be hidden by a smaller reservation and invalid budgets are rejected", async () => {
  const parent = session();
  const reservation = await reserveDelegation(parent, 4000, undefined, async () => {});
  const child = session(100);
  child.usage = { input: 3500, output: 1000, cached: 20 };
  await reservation.settle(child);
  expect(parent.budgetSpent).toBe(4500);
  await expect(reserveDelegation(parent, 4000, NaN, async () => {})).rejects.toThrow("nonnegative");
});

test("explorers reserve shared run counters before launch and settle actual usage durably", async () => {
  const { initializeRunState, settleDelegationReservation } = await import("../src/index.ts");
  const parent = session();
  const state = initializeRunState(parent, {
    modelRequests: 8,
    toolCalls: 30,
    resultBytes: 10_000,
  });
  let snapshot: Session | undefined;
  const save = async () => {
    snapshot = structuredClone(parent);
  };
  const reservation = await reserveDelegation(parent, 4000, 10000, save);
  expect(reservation.runLimits).toEqual({
    modelRequests: 6,
    toolCalls: 24,
    sideEffects: 0,
    resultBytes: 10_000,
  });
  expect(snapshot?.runState?.counters).toEqual(reservation.runLimits);
  const child = session(700);
  child.id = "child";
  child.usage = { input: 500, output: 200, cached: 50 };
  initializeRunState(child, reservation.runLimits).counters = {
    modelRequests: 2,
    toolCalls: 3,
    sideEffects: 0,
    resultBytes: 120,
  };
  await reservation.settle(child);
  expect(state.counters).toEqual({
    modelRequests: 2,
    toolCalls: 3,
    sideEffects: 0,
    resultBytes: 120,
  });
  const resumed = structuredClone(snapshot!);
  await settleDelegationReservation(resumed, reservation.id, child, async () => {});
  expect(resumed.runState?.counters).toEqual(state.counters);
  expect(resumed.budgetSpent).toBe(700);
  expect(resumed.usage).toEqual(child.usage);
});

for (const resource of ["modelRequests", "toolCalls", "resultBytes"] as const)
  test(`an exhausted parent ${resource} budget cannot launch a fresh explorer`, async () => {
    const { initializeRunState } = await import("../src/index.ts");
    const parent = session(50);
    const state = initializeRunState(parent, { [resource]: 0 });
    await expect(reserveDelegation(parent, 4000, 10000, async () => {})).rejects.toThrow(resource);
    expect(parent.budgetSpent).toBe(50);
    expect(state.counters.modelRequests).toBe(0);
    expect(state.counters.toolCalls).toBe(0);
  });

test("concurrent explorers cannot overbook the last shared model request and unknown outcomes retain counters", async () => {
  const { initializeRunState } = await import("../src/index.ts");
  const parent = session();
  const state = initializeRunState(parent, { modelRequests: 1, toolCalls: 2, resultBytes: 100 });
  const first = reserveDelegation(parent, 4000, undefined, async () => {
    await Promise.resolve();
  });
  await expect(reserveDelegation(parent, 4000, undefined, async () => {})).rejects.toThrow(
    "modelRequests",
  );
  const reservation = await first;
  expect(reservation.runLimits.modelRequests).toBe(1);
  await reservation.settle();
  expect(state.counters).toEqual({
    modelRequests: 1,
    toolCalls: 2,
    sideEffects: 0,
    resultBytes: 100,
  });
  expect(parent.budgetSpent).toBe(4000);
});
