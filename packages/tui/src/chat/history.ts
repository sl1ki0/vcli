import { createSignal } from "solid-js";
import type { Session } from "@vcli/core";
import type { WorkspaceOptions, WorkspaceSessionInfo } from "../contracts.ts";
import type { PanelChoice } from "../setup/contracts.ts";

interface HistoryOptions {
  workspace: WorkspaceOptions;
  canChange(): boolean;
  close(): void;
  activity(text: string): void;
  restore(session: Session): void;
  clear(): void;
}
export function createSessionHistory(options: HistoryOptions) {
  const [sessions, setSessions] = createSignal<WorkspaceSessionInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [selecting, setSelecting] = createSignal(false);
  const [error, setError] = createSignal("");
  let version = 0;
  async function load() {
    const request = ++version;
    setLoading(true);
    setError("");
    try {
      const records = await options.workspace.sessions!.list();
      if (request === version) setSessions(records);
    } catch (cause) {
      if (request === version)
        setError(cause instanceof Error ? cause.message : "Could not read saved sessions.");
    } finally {
      if (request === version) setLoading(false);
    }
  }
  async function resume(id: string) {
    if (!options.canChange() || loading()) return;
    setSelecting(true);
    setLoading(true);
    setError("");
    try {
      const session = await options.workspace.sessions!.open(id);
      options.restore(session);
      options.activity(`Resumed conversation · ${session.provider}/${session.model}`);
      options.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resume this session.");
    } finally {
      setLoading(false);
      setSelecting(false);
    }
  }
  async function create() {
    if (!options.canChange() || loading()) return;
    setSelecting(true);
    setLoading(true);
    try {
      await options.workspace.sessions?.create();
      options.clear();
      options.activity("New conversation. Saved sessions remain available in /history.");
      options.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start a new conversation.");
      options.activity(error());
    } finally {
      setLoading(false);
      setSelecting(false);
    }
  }
  function choices(): PanelChoice[] {
    return [
      { label: "New conversation", select: create },
      ...sessions().map((session) => ({
        label: session.title || session.id,
        detail: `${session.provider}/${session.model} · ${session.status} · ${session.tokens.toLocaleString("en-US")} tokens · ${session.updatedAt.replace("T", " ").slice(0, 16)}`,
        select: () => resume(session.id),
      })),
    ];
  }
  return {
    sessions,
    loading,
    selecting,
    error,
    load,
    create,
    choices,
    invalidate: () => {
      ++version;
      setLoading(false);
    },
  };
}
