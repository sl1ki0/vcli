import type { ScrollBoxRenderable } from "@opentui/core";
import { For } from "solid-js";
import type { ToolRequest } from "./tool-request.ts";

export function ToolApproval(props: {
  request: ToolRequest;
  onDecision(allow: boolean): void;
  onScrollRef(value: ScrollBoxRenderable): void;
}) {
  return (
    <box
      id="tool-approval"
      flexDirection="column"
      width="100%"
      height="100%"
      border
      borderColor="#fbbf24"
      backgroundColor="#1d2633"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#fbbf24" flexShrink={0}>{`Permission needed · ${props.request.title}`}</text>
      <text fg="#dce4ed" flexShrink={0}>{`Tool: ${props.request.name}`}</text>
      <scrollbox id="tool-approval-details" flexGrow={1} scrollX={false} ref={props.onScrollRef}>
        <text fg="#fbbf24" marginBottom={1}>
          {props.request.effect}
        </text>
        <For each={props.request.fields}>
          {(field) => (
            <box flexDirection="column" width="100%" marginBottom={1}>
              <text fg="#94a3b8">{field.label}</text>
              <text
                wrapMode="word"
                fg={
                  field.tone === "removed"
                    ? "#fca5a5"
                    : field.tone === "added"
                      ? "#6ee7c2"
                      : "#dce4ed"
                }
              >
                {field.text}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
      <box flexDirection="row" gap={3} flexShrink={0}>
        <text fg="#6ee7c2" onMouseDown={() => props.onDecision(true)}>
          [Y] Allow once
        </text>
        <text fg="#fca5a5" onMouseDown={() => props.onDecision(false)}>
          [N / Esc] Deny
        </text>
      </box>
      <text fg="#94a3b8" flexShrink={0}>
        ↑/↓ · PgUp/PgDn scroll · Enter denies
      </text>
    </box>
  );
}
