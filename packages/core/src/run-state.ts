import type { ApprovalDecision, Session, ToolCall, ToolKind, ToolResult } from "./contracts.ts";

export interface RunLimits {
  modelRequests: number;
  toolCalls: number;
  sideEffects: number;
  resultBytes: number;
}
export interface RunCall {
  call: ToolCall;
  signature: string;
  kind: ToolKind;
  sideEffects: number;
  retrySafe: boolean;
  status: "reserved" | "approval" | "started" | "uncertain" | "complete";
  attempts: number;
  resultAllowance?: number;
  retryRequested?: boolean;
  inspection?: { digest: string; artifact: string };
  resolutions?: { decision: "retry" | "fail" | "abort"; time: string; attempt: number }[];
  forcedResult?: ToolResult;
  result?: { output: string; artifact: string; isError: boolean; incomplete?: boolean };
  approval?: { decision?: ApprovalDecision; decidedAt?: string; schemaDigest?: string };
}
export interface RunState {
  version: 1;
  limits: RunLimits;
  counters: RunLimits;
  calls: Record<string, RunCall>;
  /** Provider batch remains intact while waiting for a decision or recovery. */
  pending: string[];
  aborted?: boolean;
  delegations?: Record<
    string,
    {
      tokens: number;
      limits: RunLimits;
      settled?: boolean;
      childSessionId?: string;
    }
  >;
}

export const defaultRunLimits: RunLimits = {
  modelRequests: 400,
  toolCalls: 2_000,
  sideEffects: 1_000,
  resultBytes: 64 * 1024 * 1024,
};
export class RunBudgetError extends Error {
  constructor(readonly resource: keyof RunLimits) {
    super(`Run budget exhausted: ${resource}. Counters are retained across resume.`);
    this.name = "RunBudgetError";
  }
}
export class ToolProtocolError extends Error {
  constructor(id: string) {
    super(`Tool protocol error: call ${id} was reused with a different tool, arguments or task.`);
    this.name = "ToolProtocolError";
  }
}
export class PendingApprovalError extends Error {
  constructor(readonly callId: string) {
    super(`Approval required for tool call ${callId}. Resolve it and resume the same run.`);
    this.name = "PendingApprovalError";
  }
}
export class UncertainToolError extends Error {
  constructor(readonly callId: string) {
    super(
      `Tool call ${callId} has an uncertain outcome. Inspect and explicitly resolve it before continuing.`,
    );
    this.name = "UncertainToolError";
  }
}

export function initializeRunState(session: Session, limits: Partial<RunLimits> = {}): RunState {
  if (session.runState) return session.runState;
  const resolved = { ...defaultRunLimits, ...limits };
  for (const [name, value] of Object.entries(resolved))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Run limit ${name} must be a nonnegative safe integer.`);
  return (session.runState = {
    version: 1,
    limits: resolved,
    counters: { modelRequests: 0, toolCalls: 0, sideEffects: 0, resultBytes: 0 },
    calls: Object.create(null) as Record<string, RunCall>,
    pending: [],
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function callSignature(call: ToolCall): string {
  return JSON.stringify(canonical({ name: call.name, arguments: call.arguments }));
}
export function savedCall(state: RunState, call: ToolCall): RunCall | undefined {
  const saved = Object.hasOwn(state.calls, call.id) ? state.calls[call.id] : undefined;
  if (saved && saved.signature !== callSignature(call)) throw new ToolProtocolError(call.id);
  return saved;
}
function requireCapacity(state: RunState, resource: keyof RunLimits, amount: number): void {
  if (state.counters[resource] + amount > state.limits[resource])
    throw new RunBudgetError(resource);
}

/** Mutate a single session snapshot; the caller saves it atomically before effects. */
export function reserveRunBatch(
  state: RunState,
  calls: ToolCall[],
  describe: (call: ToolCall) => { kind: ToolKind; retrySafe: boolean; sideEffects?: number },
): void {
  const fresh = new Map<
    string,
    { call: ToolCall; kind: ToolKind; retrySafe: boolean; sideEffects: number }
  >();
  for (const call of calls) {
    if (!call.id || typeof call.id !== "string")
      throw new Error("Tool protocol error: missing call id.");
    const saved = savedCall(state, call);
    const duplicate = fresh.get(call.id);
    if (duplicate && callSignature(duplicate.call) !== callSignature(call))
      throw new ToolProtocolError(call.id);
    if (!saved && !duplicate) {
      const descriptor = describe(call);
      const sideEffects = descriptor.sideEffects ?? (descriptor.kind === "read" ? 0 : 1);
      if (!Number.isSafeInteger(sideEffects) || sideEffects < 0)
        throw new Error("Tool side-effect cost must be a nonnegative safe integer.");
      fresh.set(call.id, { call, ...descriptor, sideEffects });
    }
  }
  requireCapacity(state, "toolCalls", fresh.size);
  requireCapacity(
    state,
    "sideEffects",
    [...fresh.values()].reduce((sum, entry) => sum + entry.sideEffects, 0),
  );
  if (fresh.size && state.counters.resultBytes >= state.limits.resultBytes)
    throw new RunBudgetError("resultBytes");
  state.counters.toolCalls += fresh.size;
  state.counters.sideEffects += [...fresh.values()].reduce(
    (sum, entry) => sum + entry.sideEffects,
    0,
  );
  for (const [id, entry] of fresh)
    Object.defineProperty(state.calls, id, {
      value: {
        ...entry,
        call: structuredClone(entry.call),
        signature: callSignature(entry.call),
        status: "reserved",
        attempts: 0,
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  state.pending = [...new Set(calls.map((call) => call.id))];
}
export function reserveModelRequest(state: RunState): void {
  requireCapacity(state, "modelRequests", 1);
  state.counters.modelRequests++;
}
/** Reserve unknown output conservatively. Failed/uncertain attempts keep their charge. */
export function startRunCall(state: RunState, entry: RunCall, maximumBytes?: number): number {
  if (entry.retryRequested) {
    requireCapacity(state, "toolCalls", 1);
    requireCapacity(state, "sideEffects", entry.sideEffects);
  }
  const available = state.limits.resultBytes - state.counters.resultBytes;
  const allowance = Math.min(available, maximumBytes ?? available);
  if (allowance <= 0) throw new RunBudgetError("resultBytes");
  if (entry.retryRequested) {
    state.counters.toolCalls++;
    state.counters.sideEffects += entry.sideEffects;
    entry.retryRequested = undefined;
  }
  state.counters.resultBytes += allowance;
  entry.resultAllowance = allowance;
  entry.status = "started";
  entry.attempts++;
  return allowance;
}
export function settleRunOutput(state: RunState, entry: RunCall, bytes: number): void {
  if (entry.resultAllowance !== undefined) {
    state.counters.resultBytes -= Math.max(0, entry.resultAllowance - bytes);
    entry.resultAllowance = undefined;
  } else {
    requireCapacity(state, "resultBytes", bytes);
    state.counters.resultBytes += bytes;
  }
}

/** UTF-8 cap applies to both artifacts and model output; the marker fits inside the cap. */
export function toolResultBytes(result: ToolResult): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(result.fullOutput ?? result.text).length +
    (result.details === undefined ? 0 : encoder.encode(JSON.stringify(result.details)).length)
  );
}
export function capToolResult(result: ToolResult, maximum: number): ToolResult {
  const encoder = new TextEncoder();
  let incomplete = result.incomplete ?? false;
  const cap = (text: string): string => {
    const bytes = encoder.encode(text);
    if (bytes.length <= maximum) return text;
    incomplete = true;
    const marker = "\n[Result incomplete: run result byte limit]";
    const suffix = encoder.encode(marker);
    const size = Math.max(0, maximum - suffix.length);
    let end = size;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return suffix.length > maximum
      ? "[incomplete]".slice(0, maximum)
      : new TextDecoder().decode(bytes.subarray(0, end)) + marker;
  };
  const text = cap(result.text);
  const fullOutput = result.fullOutput === undefined ? undefined : cap(result.fullOutput);
  let details = result.details;
  if (
    details !== undefined &&
    encoder.encode(JSON.stringify(details)).length >
      Math.max(0, maximum - encoder.encode(fullOutput ?? text).length)
  ) {
    details = undefined;
    incomplete = true;
  }
  return { ...result, text, fullOutput, details, ...(incomplete ? { incomplete: true } : {}) };
}

/** Offline commands use this helper without constructing a provider or starting a model. */
export async function resolveRunApproval(
  session: Session,
  callId: string,
  decision: ApprovalDecision,
  save: () => Promise<void>,
): Promise<void> {
  if (decision !== true && decision !== false && decision !== "always")
    throw new Error("Approval decision must be true, false or always.");
  const entry =
    session.runState && Object.hasOwn(session.runState.calls, callId)
      ? session.runState.calls[callId]
      : undefined;
  if (!entry || entry.status !== "approval") throw new Error(`No pending approval for ${callId}.`);
  entry.approval = { ...entry.approval, decision, decidedAt: new Date().toISOString() };
  entry.status = "reserved";
  session.status = "running";
  await save();
}
export type UncertainResolution = "retry" | "fail" | "abort";
export async function resolveRunUncertainty(
  session: Session,
  callId: string,
  resolution: UncertainResolution,
  options: { save: () => Promise<void>; resolveEffects?: (call: ToolCall) => Promise<void> },
): Promise<void> {
  if (!["retry", "fail", "abort"].includes(resolution))
    throw new Error("Unknown uncertainty resolution.");
  const entry =
    session.runState && Object.hasOwn(session.runState.calls, callId)
      ? session.runState.calls[callId]
      : undefined;
  if (!entry || (entry.status !== "uncertain" && entry.status !== "started"))
    throw new Error(`No uncertain tool call ${callId}.`);
  if (resolution === "retry" && !entry.retrySafe)
    throw new Error(
      `${entry.call.name} cannot be safely repeated. Mark it failed or abort the run.`,
    );
  await options.resolveEffects?.(entry.call);
  entry.resolutions ??= [];
  session.ledger.constraints = session.ledger.constraints.filter(
    (constraint) => !constraint.startsWith(`Uncertain tool call ${callId}:`),
  );
  session.ledger.decisions.push(`Resolved uncertain tool call ${callId}: ${resolution}.`);
  entry.resolutions.push({
    decision: resolution,
    time: new Date().toISOString(),
    attempt: entry.attempts,
  });
  if (resolution === "abort") {
    entry.status = "complete";
    entry.result = {
      output: entry.result?.output ?? "Run aborted after uncertain tool execution.",
      artifact: entry.result?.artifact ?? "",
      isError: true,
    };
    session.runState!.pending = session.runState!.pending.filter((id) => id !== callId);
    session.runState!.aborted = true;
    session.status = "failed";
  } else {
    entry.status = "reserved";
    entry.resultAllowance = undefined; // Spent reservation remains charged after a crash.
    entry.retryRequested = resolution === "retry";
    if (resolution === "fail")
      entry.forcedResult = {
        text: "Interrupted tool call explicitly marked unsuccessful by the user. Inspect current state before proceeding.",
        isError: true,
      };
    session.status = "running";
  }
  await options.save();
}
