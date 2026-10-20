import { For, Show } from "solid-js";
import type { RunPlanState, RunPlanTask } from "@vcli/core";

/** Dependencies determine columns; execution order remains the plan's original task order. */
export function planStages(plan: RunPlanState): RunPlanTask[][] {
  const depth = new Map<string, number>();
  function rank(task: RunPlanTask): number {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    const result = task.dependencies.length
      ? 1 +
        Math.max(...task.dependencies.map((id) => rank(plan.steps.find((step) => step.id === id)!)))
      : 0;
    depth.set(task.id, result);
    return result;
  }
  const stages: RunPlanTask[][] = [];
  for (const task of plan.steps) (stages[rank(task)] ??= []).push(task);
  return stages;
}

const symbol = { pending: "○", "in-progress": "◐", complete: "✓" } as const;
const color = { pending: "#94a3b8", "in-progress": "#fbbf24", complete: "#6ee7c2" } as const;

export function PlanView(props: { plan: RunPlanState }) {
  return (
    <box flexDirection="column" gap={1}>
      <text fg="#dce4ed">{props.plan.goal}</text>
      <text fg="#8e9ba9">
        {`${props.plan.status.toUpperCase()} · ${props.plan.steps.filter((task) => task.status === "complete").length}/${props.plan.steps.length} verified · dependencies flow left → right`}
      </text>
      <scrollbox scrollX width="100%" height={18}>
        <box flexDirection="row" gap={2}>
          <For each={planStages(props.plan)}>
            {(tasks, index) => (
              <box width={32} flexShrink={0} flexDirection="column" gap={1}>
                <text fg="#38bdf8">{`STAGE ${index() + 1}${index() ? " ← dependencies" : " · ready first"}`}</text>
                <For each={tasks}>
                  {(task) => (
                    <box
                      width={32}
                      border
                      borderColor={color[task.status]}
                      paddingLeft={1}
                      paddingRight={1}
                      flexDirection="column"
                    >
                      <text
                        fg={color[task.status]}
                      >{`${symbol[task.status]} ${task.id} · ${task.status}`}</text>
                      <text fg="#dce4ed">{task.description}</text>
                      <Show when={task.dependencies.length}>
                        <text fg="#38bdf8">{`← ${task.dependencies.join(", ")}`}</text>
                      </Show>
                      <text fg="#8e9ba9">{`Tools: ${task.tools.join(", ")}`}</text>
                      <text fg="#b8c4d2">{`Ready: ${task.doneWhen}`}</text>
                      <text fg={task.verifiedBy?.length ? "#6ee7c2" : "#94a3b8"}>
                        {task.verifiedBy?.length
                          ? `${task.verifiedBy.length} recorded verification calls`
                          : `Verify: ${task.verificationTool}`}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <text fg="#fbbf24">{`Risks: ${props.plan.risks.join("; ") || "none identified"}`}</text>
      <text fg="#94a3b8">{`Assumptions: ${props.plan.assumptions.join("; ") || "none"}`}</text>
      <text fg="#6ee7c2">{`Done when: ${props.plan.doneWhen}`}</text>
    </box>
  );
}
