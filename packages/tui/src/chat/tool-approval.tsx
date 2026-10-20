import type { ScrollBoxRenderable } from "@opentui/core";
import type { ApprovalDecision } from "@vcli/core";
import { For } from "solid-js";
import type { ToolRequest } from "./tool-request.ts";
import type { approvalActions } from "./approval-actions.ts";

export function ToolApproval(props: {
  request: ToolRequest;
  selected: number;
  actions: typeof approvalActions;
  onDecision(allow: ApprovalDecision): void;
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
      <box flexDirection="column" flexShrink={0}>
        <For each={props.actions}>
          {(action, index) => (
            <text
              id={`approval-action-${index()}`}
              fg={props.selected === index() ? "#111821" : action.color}
              bg={props.selected === index() ? action.color : undefined}
              onMouseDown={() => props.onDecision(action.decision)}
            >{`${props.selected === index() ? "›" : " "} ${action.label}`}</text>
          )}
        </For>
      </box>
      <text fg="#94a3b8" flexShrink={0}>
        ↑/↓ select · Enter confirm · Esc deny · PgUp/PgDn scroll
      </text>
    </box>
  );
}
