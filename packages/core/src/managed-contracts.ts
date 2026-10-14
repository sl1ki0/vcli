import type { Message, ToolCall, ToolSchema } from "./contracts.ts";

/** Portable contracts for the opt-in, durable homework workflow. */
export interface RunLimits {
  modelRequests: number;
  toolCalls: number;
  sideEffects: number;
  resultBytes: number;
}
export interface RunFile {
  content: string;
  hash: string;
  mode: number;
}
export type RunTree = Record<string, RunFile>;
export interface RunJournal {
  initial: RunTree;
  expected: RunTree;
  changes: { path: string; before?: RunFile; after?: RunFile }[];
}
export interface RunTask {
  id: string;
  description: string;
  dependsOn: string[];
  tools: string[];
  outcome: { tool: string; contains?: string; exitCode?: number };
  state: "pending" | "active" | "complete";
  evidence?: { callId: string; text: string };
}
export interface RunPlan {
  goal: string;
  steps: RunTask[];
  risks: string[];
  assumptions: string[];
  doneWhen: string;
}
export interface RunResult {
  text: string;
  isError?: boolean;
  truncated?: boolean;
  exitCode?: number;
}
export interface RunCall {
  call: ToolCall;
  taskId?: string;
  phase: "planning" | "execution";
  state: "pending" | "started" | "complete" | "uncertain";
  attempts: number;
  approval?: "allow" | "deny";
  decisions: { action: string; time: string }[];
  result?: RunResult;
}
export interface ManagedRun {
  version: 1;
  revision: number;
  id: string;
  root: string;
  policyPath: string;
  mode: "safe" | "auto";
  phase: "planning" | "execution";
  status:
    | "running"
    | "waiting-plan"
    | "waiting-approval"
    | "uncertain"
    | "budget"
    | "complete"
    | "failed"
    | "rejected"
    | "rolling-back"
    | "rolled-back";
  goal: string;
  messages: Message[];
  limits: RunLimits;
  spent: RunLimits;
  calls: RunCall[];
  batch: ToolCall[];
  batchIndex: number;
  plan?: RunPlan;
  planDecision?: "approve" | "reject";
  journal: RunJournal;
  error?: string;
  provider?: { id: string; model: string };
  tokenBudget?: { limit: number; spent: number };
  schemaErrors?: { tool: string; count: number }[];
}
export interface ManagedStore {
  /** Atomically writes the full snapshot with optimistic revision checking. */
  save(run: ManagedRun): Promise<void>;
  get(id: string): Promise<ManagedRun>;
}
export interface ManagedExecutor {
  schemas: ToolSchema[];
  validate(call: ToolCall): void;
  kind(name: string): "read" | "write" | "delete" | "bash" | "control";
  /** Rechecks schema, policy, canonical paths and the full command at execution time. */
  check(call: ToolCall): Promise<void>;
  execute(call: ToolCall, resultBytes: number, signal: AbortSignal): Promise<RunResult>;
}
export interface ManagedJournal {
  capture(): Promise<RunTree>;
  before(run: ManagedRun): Promise<void>;
  after(run: ManagedRun): Promise<void>;
  inspect(run: ManagedRun): Promise<string>;
  /** All affected paths/policy/hashes are validated before any restoration. */
  rollback(run: ManagedRun): Promise<void>;
}
