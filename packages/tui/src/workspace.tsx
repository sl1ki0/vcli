import { For, Show } from "solid-js";
import { useWorkspaceState } from "./workspace-state.ts";
import { EmptyProject, WorkspacePanels } from "./workspace-panels.tsx";
import type { WorkspaceOptions } from "./contracts.ts";
export type { WorkspaceOptions } from "./contracts.ts";
export function Workspace(props: WorkspaceOptions) {
  const state = useWorkspaceState(props);
  const {
    view,
    usage,
    graph,
    graphics,
    treeWidth,
    visibleNodes,
    selected,
    collapsed,
    canvasWidth,
    canvasHeight,
    selectAt,
    image,
    touched,
    canvasFocus,
    protocol,
    narrow,
    narrowPanel,
    inspectorWidth,
    selectedNode,
    approval,
    activity,
    transcript,
    searching,
    running,
    submit,
  } = state;
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#111821">
      <box height={2} paddingLeft={1} flexDirection="column">
        <text
          height={1}
          wrapMode="none"
          fg="#6ee7c2"
        >{`vcli   ${view().toUpperCase()}   ${(state.commands.settings()?.permission ?? props.permission).toUpperCase()}   ${state.commands.settings() ? `${state.commands.settings()!.provider}/${state.commands.settings()!.model || "no model"} · key:${state.commands.settings()!.credential}` : "not connected"}   ${usage()}`}</text>
        <text
          height={1}
          wrapMode="none"
          fg="#8e9ba9"
        >{`${props.root} · ${graph().nodes.length} nodes · ${graph().edges.length} relations · ${graphics() ? (state.imageProtocol() ?? "graphics") : "tree fallback"}`}</text>
      </box>
      <Show
        when={state.commands.panel()}
        fallback={
          <Show
            when={!state.commands.emptyProject()}
            fallback={
              <box height={canvasHeight()}>
                <EmptyProject root={props.root} commands={state.commands} />
              </box>
            }
          >
            <box flexDirection="row" height={canvasHeight()}>
              <Show when={treeWidth() > 0}>
                <scrollbox width={treeWidth()} height="100%" backgroundColor="#17212d">
                  <For each={visibleNodes()}>
                    {(node) => (
                      <text
                        fg={node.id === selected() ? "#6ee7c2" : "#b8c4d2"}
                        onMouseDown={() => state.selectNode(node.id)}
                      >{`${node.parent ? "  " : ""}${collapsed().has(node.id) ? "+ " : ""}${node.label}`}</text>
                    )}
                  </For>
                </scrollbox>
              </Show>
              <box
                ref={state.setCanvasBox}
                width={canvasWidth()}
                height={canvasHeight()}
                onMouseDown={selectAt}
                flexDirection="column"
              >
                <Show
                  when={image() && graphics()}
                  fallback={
                    <scrollbox width="100%" height="100%">
                      <Show
                        when={narrow() && narrowPanel() === "inspector"}
                        fallback={
                          <>
                            <text fg="#8e9ba9">{`Architecture ${view()} · ${canvasFocus() ? "canvas focused" : "Tab to navigate"}`}</text>
                            <For each={visibleNodes()}>
                              {(node) => (
                                <text
                                  fg={node.id === selected() ? "#6ee7c2" : "#b8c4d2"}
                                  onMouseDown={() => state.selectNode(node.id)}
                                >{`${node.id === selected() ? "›" : " "} ${node.label}${touched().has(node.path ?? "") ? " [changed]" : ""}\n  ${graph()
                                  .edges.filter(
                                    (e) => e.source === node.id && e.kind !== "contains",
                                  )
                                  .slice(0, 4)
                                  .map(
                                    (e) =>
                                      graph().nodes.find((n) => n.id === e.target)?.label ??
                                      e.target,
                                  )
                                  .join(" → ")}`}</text>
                              )}
                            </For>
                          </>
                        }
                      >
                        <text fg="#6ee7c2">{selectedNode()?.label ?? "Select a module"}</text>
                        <text fg="#b8c4d2">{`${selectedNode()?.path ?? ""}\n${selectedNode()?.status ?? ""}\n\n${selectedNode()?.signatures?.join("\n") ?? ""}`}</text>
                      </Show>
                    </scrollbox>
                  }
                >
                  <image
                    id="architecture-image"
                    ref={state.setImageRef}
                    source={image()}
                    width={canvasWidth()}
                    height={canvasHeight()}
                    fit="fill"
                    protocol={protocol()}
                    onError={state.imageError}
                  />
                </Show>
              </box>
              <Show when={!narrow()}>
                <box
                  width={inspectorWidth()}
                  paddingLeft={1}
                  flexDirection="column"
                  backgroundColor="#17212d"
                >
                  <text fg="#6ee7c2">{selectedNode()?.label ?? "Select a module"}</text>
                  <text fg="#b8c4d2">{`${selectedNode()?.kind ?? ""}\n${selectedNode()?.path ?? ""}\n${selectedNode()?.status ?? ""}\n\n${selectedNode()?.signatures?.slice(0, 6).join("\n") ?? ""}`}</text>
                </box>
              </Show>
            </box>
          </Show>
        }
      >
        <box height={canvasHeight()}>
          <WorkspacePanels commands={state.commands} root={props.root} running={running()} />
        </box>
      </Show>
      <box height={3} paddingLeft={1} flexDirection="column">
        <text fg={approval() ? "#fbbf24" : "#8e9ba9"}>
          {approval() ? `Approve? [y/n] ${approval()!.label}` : activity().slice(-500)}
        </text>
      </box>
      <scrollbox height={3} stickyScroll stickyStart="bottom" paddingLeft={1}>
        <text fg="#dce4ed">
          {transcript() ||
            (narrow() ? `${selectedNode()?.label ?? ""} ${selectedNode()?.path ?? ""}` : "")}
        </text>
      </scrollbox>
      <box height={1} paddingLeft={1}>
        <Show
          when={!state.commands.panel()}
          fallback={<text fg="#8e9ba9">Local setup · Esc returns to the workspace</text>}
        >
          <input
            id="task-input"
            focused={!canvasFocus() && !approval()}
            placeholder={
              searching()
                ? "Search modules…"
                : running()
                  ? "Agent working · Ctrl+C stops"
                  : state.commands.ready()
                    ? "Describe a task · /help commands · /tokens budgets"
                    : "Connect with /connect · /open project · F1 help"
            }
            onSubmit={(value) => {
              if (typeof value === "string") void submit(value);
            }}
          />
        </Show>
      </box>
      <text height={1} wrapMode="none" fg="#64748b" onMouseDown={() => state.commands.open("help")}>
        {narrow()
          ? "F1 Help · /config settings · /tokens budgets · Tab focus · Ctrl+C stop"
          : "F1 Help · /config settings · /tokens budgets · Tab focus · arrows select · Shift+arrows pan · +/- zoom · Esc reset · Ctrl+C stop"}
      </text>
    </box>
  );
}
