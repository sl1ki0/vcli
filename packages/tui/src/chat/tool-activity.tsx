import { Show } from "solid-js";
import { displayToolText, type ChatMessage } from "@vcli/core";
import type { Conversation } from "./conversation.ts";
import { sliceToolText, toolPageStride } from "./tool-text.ts";

const actions: Record<string, string> = {
  files_read: "Read file",
  files_list: "List files",
  files_search: "Search files",
  files_patch: "Edit file",
  shell: "Run command",
  shell_run: "Run command",
  architecture_propose: "Save intended architecture",
  architecture_preview: "Preview architecture",
  architecture_scan: "Scan architecture",
  architecture_query: "Inspect architecture",
  tools_search: "Find tools",
  artifacts_read: "Read saved result",
  git_diff: "Review file changes",
  skills_load: "Read skill instructions",
  tasks_list: "List tasks",
  tasks_update: "Update task",
  task_record: "Update task ledger",
  checkpoint_list: "List checkpoints",
  checkpoint_restore: "Restore checkpoint",
  subagent_explore: "Explore with a helper",
  memory_read: "Read project memory",
  memory_write: "Update project memory",
};
const states = {
  requested: { label: "Waiting", color: "#fbbf24", icon: "○" },
  running: { label: "Running", color: "#38bdf8", icon: "↻" },
  complete: { label: "Succeeded", color: "#6ee7c2", icon: "✓" },
  failed: { label: "Failed", color: "#fca5a5", icon: "!" },
  interrupted: { label: "Interrupted", color: "#fbbf24", icon: "!" },
  blocked: { label: "Blocked", color: "#fca5a5", icon: "!" },
};

/** Plain, bounded details stay separate from assistant Markdown and provider messages. */
export function ToolActivity(props: { message: ChatMessage; conversation: Conversation }) {
  const tool = () => props.message.tool;
  const state = () => states[tool()?.state ?? "interrupted"];
  const expanded = () => props.conversation.expandedTools().has(props.message.id);
  const artifact = () => props.conversation.artifacts()[props.message.id];
  const failed = () => ["failed", "blocked", "interrupted"].includes(tool()?.state ?? "");
  const pageCount = () =>
    Math.max(1, Math.ceil((artifact()?.content?.length ?? 0) / toolPageStride));
  const preview = () => {
    const limit = expanded() ? 4000 : failed() ? 1000 : 180;
    const text = props.message.text;
    return (
      displayToolText(sliceToolText(text, 0, limit)) +
      (text.length > limit ? "\n… Expand for details or open the full saved result." : "")
    );
  };
  return (
    <box
      flexDirection="column"
      width="100%"
      border
      borderColor={state().color}
      paddingLeft={1}
      paddingRight={1}
    >
      <text
        fg={state().color}
        wrapMode="word"
        onMouseDown={() => props.conversation.toggleDetails(props.message.id)}
      >
        {`${expanded() ? "▾" : "▸"} ${state().icon} ${actions[tool()?.name ?? ""] ?? (tool()?.kind === "read" ? "Read information" : tool()?.kind === "execute" ? "Run action" : "Update saved state")} · ${state().label}`}
      </text>
      <text
        fg="#94a3b8"
        wrapMode="word"
      >{`Tool: ${displayToolText(tool()?.name ?? "unknown")}`}</text>
      <Show when={tool()?.target}>
        <text
          fg="#dce4ed"
          wrapMode="word"
        >{`Target: ${displayToolText(tool()?.target ?? "")}`}</text>
      </Show>
      <Show when={props.message.text}>
        <text fg={failed() ? "#fca5a5" : "#dce4ed"} wrapMode="word">
          {`${failed() ? "Error" : "Result"}: ${preview()}`}
        </text>
      </Show>
      <Show when={expanded()}>
        <text fg="#94a3b8" marginTop={1}>
          Input
        </text>
        <text fg="#dce4ed" wrapMode="word">
          {displayToolText(tool()?.input ?? "(not recorded)")}
        </text>
        <Show when={tool()?.artifact && props.conversation.canReadArtifact}>
          <text
            id={`tool-artifact-${props.message.id}`}
            fg="#38bdf8"
            marginTop={1}
            wrapMode="word"
            onMouseDown={() => {
              void props.conversation.openArtifact(props.message.id);
            }}
          >
            {artifact()?.loading
              ? "Opening full saved result…"
              : artifact()?.content !== undefined
                ? "Full saved result · local view"
                : "[F] Open full saved result · local view"}
          </text>
          <Show when={artifact()?.error}>
            <text fg="#fca5a5" wrapMode="word">
              {artifact()?.error}
            </text>
          </Show>
          <Show when={artifact()?.content !== undefined}>
            <text id={`tool-artifact-content-${props.message.id}`} fg="#dce4ed" wrapMode="word">
              {displayToolText(
                sliceToolText(
                  artifact()!.content!,
                  artifact()!.page * toolPageStride,
                  (artifact()!.page + 1) * toolPageStride,
                ),
              ) || "(empty result)"}
            </text>
            <box flexDirection="column" width="100%">
              <text fg="#94a3b8">{`Page ${artifact()!.page + 1}/${pageCount()} · ←/→ pages`}</text>
              <text
                fg="#38bdf8"
                onMouseDown={() => props.conversation.changeArtifactPage(-1, props.message.id)}
              >
                [←] Previous page
              </text>
              <text
                fg="#38bdf8"
                onMouseDown={() => props.conversation.changeArtifactPage(1, props.message.id)}
              >
                [→] Next page
              </text>
            </box>
          </Show>
        </Show>
      </Show>
      <text
        fg="#64748b"
        wrapMode="word"
      >{`${expanded() ? "Hide" : "Show"} details · click or Space/Enter`}</text>
    </box>
  );
}
