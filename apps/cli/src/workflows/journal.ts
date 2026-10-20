import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolCall, ToolContext } from "@vcli/core";
import { restoreFiles } from "./journal-restoration.ts";
import { JournalStore } from "./journal-store.ts";
import {
  captureTree,
  changedFiles,
  sameFile,
  type JournalFile,
  type JournalTree,
} from "./journal-snapshot.ts";
import { ProjectPolicy } from "./policy.ts";

interface Change {
  before?: JournalFile;
  after?: JournalFile;
}
interface PendingAction {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  before: JournalTree;
}
interface RunRecord {
  version: 1;
  root: string;
  runId: string;
  expected: JournalTree;
  changes: Record<string, Change>;
  pending?: PendingAction;
  /** Retained until a later action so a core-result persistence crash still has its before snapshot. */
  last?: PendingAction;
  rolledBack?: boolean;
}
export interface JournalToken {
  runId: string;
  id: string;
  callId: string;
}
export interface JournalSummary {
  runId: string;
  paths: string[];
  pending?: { callId: string; name: string };
  rolledBack: boolean;
  diff: string;
}

function printable(file?: JournalFile): string[] {
  if (!file) return [];
  const content = Buffer.from(file.bytes, "base64").toString("utf8");
  return content.includes("\0") ? ["[binary content]"] : content.split("\n");
}
function formatDiff(changes: Record<string, Change>): string {
  return Object.entries(changes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, change]) => {
      const before = printable(change.before);
      const after = printable(change.after);
      return [
        `diff --vcli ${path}`,
        `--- ${change.before ? path : "/dev/null"} (${change.before?.digest ?? "absent"})`,
        `+++ ${change.after ? path : "/dev/null"} (${change.after?.digest ?? "absent"})`,
        ...before.map((line) => `-${line}`),
        ...after.map((line) => `+${line}`),
        ...(change.before?.mode !== change.after?.mode
          ? [
              `mode ${change.before?.mode.toString(8) ?? "absent"} -> ${change.after?.mode.toString(8) ?? "absent"}`,
            ]
          : []),
      ].join("\n");
    })
    .join("\n\n");
}
function reconcile(record: RunRecord, tree: JournalTree): void {
  for (const path of changedFiles(record.expected, tree)) {
    const previous = record.changes[path];
    const before = previous ? previous.before : record.expected[path];
    const after = tree[path];
    if (sameFile(before, after)) delete record.changes[path];
    else record.changes[path] = { before, after };
  }
  record.expected = tree;
  delete record.pending;
}

/** A run-wide journal complements individual checkpoints and covers shell/hook project changes. */
export class RunJournal {
  private readonly store: JournalStore;
  private readonly policy: Promise<ProjectPolicy>;
  private queue = Promise.resolve();

  constructor(
    private readonly root: string,
    options: { stateDirectory?: string; policy?: ProjectPolicy } = {},
  ) {
    this.root = realpathSync(resolve(root));
    this.store = new JournalStore(this.root, options.stateDirectory);
    this.policy = options.policy ? Promise.resolve(options.policy) : ProjectPolicy.load(this.root);
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async load(runId: string): Promise<RunRecord | undefined> {
    const record = await this.store.read<RunRecord>(runId);
    if (record && (record.version !== 1 || record.root !== this.root || record.runId !== runId))
      throw new Error("Journal record does not match this project and run.");
    if (record) {
      // JSON dictionaries must not inherit names such as constructor or __proto__ from Object.
      record.expected = Object.assign(Object.create(null), record.expected) as JournalTree;
      record.changes = Object.assign(Object.create(null), record.changes) as Record<string, Change>;
      for (const action of [record.pending, record.last])
        if (action)
          action.before = Object.assign(Object.create(null), action.before) as JournalTree;
    }
    return record;
  }

  async before(
    call: ToolCall,
    context: ToolContext,
    options: { force?: boolean } = {},
  ): Promise<JournalToken | undefined> {
    if (
      !options.force &&
      !["files_patch", "files_write", "files_delete", "shell_run"].includes(call.name)
    )
      return undefined;
    return this.transaction(async () => {
      context.signal.throwIfAborted();
      const policy = await this.policy;
      await policy.assertTool(call, context);
      let record = await this.load(context.sessionId);
      if (record?.pending)
        throw new Error(
          `Run has an uncertain journal action ${record.pending.callId}. Inspect and explicitly resolve it before another mutation.`,
        );
      const tree = await captureTree(this.root, await this.policy);
      if (record) {
        const conflicts = changedFiles(record.expected, tree);
        if (conflicts.length)
          throw new Error(
            `Project changed outside this run; action stopped: ${conflicts.join(", ")}`,
          );
      } else
        record = {
          version: 1,
          root: this.root,
          runId: context.sessionId,
          expected: tree,
          changes: Object.create(null) as Record<string, Change>,
        };
      const pending: PendingAction = {
        id: randomUUID(),
        callId: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        before: tree,
      };
      if (record.rolledBack) record.changes = Object.create(null) as Record<string, Change>;
      record.pending = pending;
      record.rolledBack = false;
      await this.store.write(record.runId, record);
      return { runId: record.runId, id: pending.id, callId: call.id };
    });
  }

  async after(token: JournalToken | undefined): Promise<void> {
    if (!token) return;
    return this.transaction(async () => {
      const record = await this.load(token.runId);
      if (
        !record?.pending ||
        record.pending.id !== token.id ||
        record.pending.callId !== token.callId
      )
        throw new Error("Journal action token does not match the pending action.");
      record.last = record.pending;
      reconcile(record, await captureTree(this.root, await this.policy));
      await this.store.write(token.runId, record);
    });
  }

  async inspect(runId: string): Promise<JournalSummary> {
    const record = await this.load(runId);
    const changes = record?.changes ?? {};
    return {
      runId,
      paths: Object.keys(changes).sort(),
      pending: record?.pending && { callId: record.pending.callId, name: record.pending.name },
      rolledBack: record?.rolledBack ?? false,
      diff: formatDiff(changes) || "No project file changes recorded.",
    };
  }

  async inspectUncertain(runId: string, callId?: string): Promise<string> {
    const record = await this.load(runId);
    const action =
      record?.pending ?? (callId && record?.last?.callId === callId ? record?.last : undefined);
    if (!action) return "No uncertain journal action.";
    if (callId && action.callId !== callId)
      throw new Error("Uncertain journal call identifier mismatch.");
    const tree = await captureTree(this.root, await this.policy);
    const changes: Record<string, Change> = Object.create(null) as Record<string, Change>;
    for (const path of changedFiles(action.before, tree))
      changes[path] = { before: action.before[path], after: tree[path] };
    return `Uncertain ${action.name} (${action.callId}). Explicitly attribute or discard detected changes before rollback.\n${formatDiff(changes) || "No project file changes detected."}`;
  }

  async resolvePending(runId: string, callId: string, attributeChanges: boolean): Promise<void> {
    return this.transaction(async () => {
      const record = await this.load(runId);
      const action =
        record?.pending ?? (callId && record?.last?.callId === callId ? record?.last : undefined);
      if (!record || !action) return;
      if (action.callId !== callId) throw new Error("Uncertain journal call identifier mismatch.");
      const tree = await captureTree(this.root, await this.policy);
      if (attributeChanges) reconcile(record, tree);
      else {
        // Discarding attribution never discards the on-disk edits. They remain outside this run.
        record.expected = tree;
        for (const path of Object.keys(record.changes)) {
          if (
            !sameFile(record.changes[path]!.after, tree[path]) ||
            !sameFile(action.before[path], tree[path])
          )
            delete record.changes[path];
        }
        delete record.pending;
      }
      delete record.last;
      await this.store.write(runId, record);
    });
  }

  async rollback(runId: string): Promise<JournalSummary> {
    return this.transaction(async () => {
      const record = await this.load(runId);
      if (!record) throw new Error("No change journal exists for this run.");
      if (record.rolledBack)
        return {
          runId,
          paths: Object.keys(record.changes).sort(),
          rolledBack: true,
          diff: "Run changes were already restored.",
        };
      if (record.pending)
        throw new Error(
          "Resolve the uncertain action and attribute detected changes before rollback.",
        );
      const policy = await this.policy;
      const paths = Object.keys(record.changes).sort();
      const current = await captureTree(this.root, await this.policy);
      const conflicts = paths.filter(
        (path) => !sameFile(record.changes[path]!.after, current[path]),
      );
      if (conflicts.length)
        throw new Error(`Rollback conflict; no files were changed: ${conflicts.join(", ")}`);
      // Validate every destination before creating even a temporary file.
      const destinations = await Promise.all(
        paths.map((path) => policy.resolvePath(path, { write: true })),
      );
      for (const path of paths) {
        if (
          record.changes[path]!.before?.digest.startsWith("link:") ||
          current[path]?.digest.startsWith("link:")
        )
          throw new Error("Rollback refuses symbolic links; no files were changed.");
      }
      const entries = paths.map((path, index) => ({
        destination: destinations[index]!,
        ...record.changes[path]!,
      }));
      await restoreFiles(entries, policy, async () => {
        record.pending = {
          id: randomUUID(),
          callId: `rollback-${randomUUID()}`,
          name: "journal_rollback",
          arguments: "{}",
          before: current,
        };
        await this.store.write(runId, record);
      });
      record.expected = await captureTree(this.root, await this.policy);
      record.rolledBack = true;
      delete record.pending;
      await this.store.write(runId, record);
      return {
        runId,
        paths,
        rolledBack: true,
        diff: "Run changes restored to their original bytes and modes.",
      };
    });
  }
}
