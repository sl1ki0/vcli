import { Show } from "solid-js";
import { useWorkspaceState } from "./workspace-state.ts";
import { WorkspacePanels } from "./workspace-panels.tsx";
import { ArchitectureView } from "./architecture-view.tsx";
import { ChatTranscript } from "./chat/transcript.tsx";
import { ToolApproval } from "./chat/tool-approval.tsx";
import { CommandSuggestions } from "./chat/command-suggestions.tsx";
import type { WorkspaceOptions } from "./contracts.ts";
export type { WorkspaceOptions } from "./contracts.ts";

export function Workspace(props: WorkspaceOptions) {
  const state = useWorkspaceState(props);
  const settings = state.commands.settings;
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#111821">
      <box height={2} flexShrink={0} paddingLeft={1} flexDirection="column">
        <text
          height={1}
          wrapMode="none"
          fg="#6ee7c2"
        >{`vcli   ${state.commands.mode().toUpperCase()}   ${state.view().toUpperCase()}   ${(settings()?.permission ?? props.permission).toUpperCase()}   ${settings() ? `${settings()!.provider}/${settings()!.model || "no model"} · key:${settings()!.credential}` : "not connected"}   ${state.usage()}`}</text>
        <text
          height={1}
          wrapMode="none"
          fg="#8e9ba9"
        >{`${props.root} · ${state.graph().nodes.length} nodes · ${state.graph().edges.length} relations · ${state.layout() === "chat" ? "architecture hidden" : state.graphics() ? (state.imageProtocol() ?? "graphics") : "tree fallback"} · reasoning:${settings()?.reasoning ?? "default"}`}</text>
      </box>
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row" gap={3}>
        <text
          fg={state.layout() === "chat" ? "#6ee7c2" : "#94a3b8"}
          onMouseDown={() => state.changeLayout("chat")}
        >
          Chat · F2
        </text>
        <text
          fg={state.layout() === "split" ? "#6ee7c2" : "#94a3b8"}
          onMouseDown={() => state.changeLayout("split")}
        >
          Split
        </text>
        <text
          fg={state.layout() === "architecture" ? "#6ee7c2" : "#94a3b8"}
          onMouseDown={() => state.changeLayout("architecture")}
        >
          Architecture · F3
        </text>
        <text
          fg="#38bdf8"
          onMouseDown={() => {
            void state.commands.execute("/history");
          }}
        >
          History
        </text>
        <text fg="#38bdf8" onMouseDown={() => state.commands.open("reasoning")}>
          Reasoning
        </text>
        <Show when={state.conversation.plan()}>
          <text fg="#38bdf8" onMouseDown={() => state.commands.open("plan")}>
            Plan
          </text>
        </Show>
        <Show when={state.running()}>
          <text fg="#fbbf24" onMouseDown={state.stopTask}>
            Stop · Ctrl+C
          </text>
        </Show>
        <Show when={state.narrow() && state.layout() !== "chat" && !state.commands.panel()}>
          <text
            height={1}
            fg="#64748b"
          >{`${state.selectedNode()?.label ?? ""} · ${state.selectedNode()?.path ?? ""}`}</text>
        </Show>
      </box>
      <box height={state.bodyHeight()} flexShrink={0} flexDirection="column">
        <Show
          when={state.commands.panel()}
          fallback={
            <Show
              when={state.approval()}
              fallback={
                <>
                  <Show when={state.layout() !== "chat"}>
                    <ArchitectureView state={state} root={props.root} />
                  </Show>
                  <Show when={state.layout() !== "architecture"}>
                    <box height={state.chatHeight()} flexShrink={0}>
                      <ChatTranscript
                        conversation={state.conversation}
                        focused={state.chatFocus()}
                        running={state.running()}
                        onFocus={state.focusChat}
                        onScrollRef={state.setChatScroll}
                        onOpenPlan={() => state.commands.open("plan")}
                      />
                    </box>
                  </Show>
                </>
              }
            >
              {(approval) => (
                <ToolApproval
                  request={approval().request}
                  selected={approval().selected}
                  actions={approval().actions}
                  onDecision={state.approve}
                  onScrollRef={state.setApprovalScroll}
                />
              )}
            </Show>
          }
        >
          <WorkspacePanels commands={state.commands} root={props.root} running={state.running()} />
        </Show>
      </box>
      <box height={2} flexShrink={0} paddingLeft={1} flexDirection="column">
        <text fg={state.approval() ? "#fbbf24" : "#8e9ba9"}>
          {state.approval()
            ? "Waiting for your permission · / to type a command · Ctrl+P changes mode"
            : state.activity().slice(-500)}
        </text>
      </box>
      <CommandSuggestions completion={state.completion} />
      <box height={1} flexShrink={0} paddingLeft={1}>
        <Show
          when={!state.commands.panel()}
          fallback={<text fg="#8e9ba9">Local setup · Esc returns to the workspace</text>}
        >
          <input
            id="task-input"
            ref={state.setInputRef}
            value={state.inputValue()}
            onInput={state.setInputValue}
            focused={
              !state.canvasFocus() &&
              !state.chatFocus() &&
              (!state.approval() || state.approvalCommand())
            }
            onMouseDown={state.beginApprovalCommand}
            placeholder={
              state.searching()
                ? "Search modules…"
                : state.running()
                  ? "Agent working · Ctrl+C stops"
                  : state.commands.ready()
                    ? "Message the model · /help commands · F2 full chat"
                    : "Connect with /connect · /open project · F1 help"
            }
            onSubmit={(value) => {
              if (typeof value === "string") void state.submit(value);
            }}
          />
        </Show>
      </box>
      <text
        height={1}
        flexShrink={0}
        wrapMode="none"
        fg="#64748b"
        onMouseDown={() => state.commands.open("help")}
      >
        F1 Help · F2 chat · F3 architecture · Ctrl+P permissions · /history · Tab focus · Ctrl+C
        stop
      </text>
    </box>
  );
}
