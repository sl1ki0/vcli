import { For, Show } from "solid-js";
import { EmptyProject } from "./workspace-panels.tsx";
import type { WorkspaceState } from "./workspace-state.ts";

export function ArchitectureView(props: { state: WorkspaceState; root: string }) {
  const state = props.state;
  return (
    <Show
      when={!state.commands.emptyProject()}
      fallback={
        <box height={state.canvasHeight()}>
          <EmptyProject root={props.root} commands={state.commands} />
        </box>
      }
    >
      <box flexDirection="row" height={state.canvasHeight()} flexShrink={0}>
        <Show when={state.treeWidth() > 0}>
          <scrollbox width={state.treeWidth()} height="100%" backgroundColor="#17212d">
            <For each={state.visibleNodes()}>
              {(node) => (
                <text
                  fg={node.id === state.selected() ? "#6ee7c2" : "#b8c4d2"}
                  onMouseDown={() => state.selectNode(node.id)}
                >{`${node.parent ? "  " : ""}${state.collapsed().has(node.id) ? "+ " : ""}${node.label}`}</text>
              )}
            </For>
          </scrollbox>
        </Show>
        <box
          ref={state.setCanvasBox}
          width={state.canvasWidth()}
          height={state.canvasHeight()}
          onMouseDown={state.selectAt}
          flexDirection="column"
        >
          <Show
            when={state.image() && state.graphics()}
            fallback={
              <scrollbox width="100%" height="100%">
                <Show
                  when={state.narrow() && state.narrowPanel() === "inspector"}
                  fallback={
                    <>
                      <text fg="#8e9ba9">{`Architecture ${state.view()} · ${state.canvasFocus() ? "canvas focused" : "Tab to navigate"}`}</text>
                      <For each={state.visibleNodes()}>
                        {(node) => (
                          <text
                            fg={node.id === state.selected() ? "#6ee7c2" : "#b8c4d2"}
                            onMouseDown={() => state.selectNode(node.id)}
                          >{`${node.id === state.selected() ? "›" : " "} ${node.label}${state.touched().has(node.path ?? "") ? " [changed]" : ""}\n  ${state
                            .graph()
                            .edges.filter(
                              (edge) => edge.source === node.id && edge.kind !== "contains",
                            )
                            .slice(0, 4)
                            .map(
                              (edge) =>
                                state.graph().nodes.find((target) => target.id === edge.target)
                                  ?.label ?? edge.target,
                            )
                            .join(" → ")}`}</text>
                        )}
                      </For>
                    </>
                  }
                >
                  <text fg="#6ee7c2">{state.selectedNode()?.label ?? "Select a module"}</text>
                  <text fg="#b8c4d2">{`${state.selectedNode()?.path ?? ""}\n${state.selectedNode()?.status ?? ""}\n\n${state.selectedNode()?.signatures?.join("\n") ?? ""}`}</text>
                </Show>
              </scrollbox>
            }
          >
            <image
              id="architecture-image"
              ref={state.setImageRef}
              source={state.image()}
              width={state.canvasWidth()}
              height={state.canvasHeight()}
              fit="fill"
              protocol={state.protocol()}
              onError={state.imageError}
            />
          </Show>
        </box>
        <Show when={!state.narrow()}>
          <box
            width={state.inspectorWidth()}
            paddingLeft={1}
            flexDirection="column"
            backgroundColor="#17212d"
          >
            <text fg="#6ee7c2">{state.selectedNode()?.label ?? "Select a module"}</text>
            <text fg="#b8c4d2">{`${state.selectedNode()?.kind ?? ""}\n${state.selectedNode()?.path ?? ""}\n${state.selectedNode()?.status ?? ""}\n\n${state.selectedNode()?.signatures?.slice(0, 6).join("\n") ?? ""}`}</text>
          </box>
        </Show>
      </box>
    </Show>
  );
}
