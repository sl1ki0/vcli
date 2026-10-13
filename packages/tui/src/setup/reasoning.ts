import type { ReasoningEffort } from "@vcli/core";
import type { PanelChoice, SetupHost } from "./contracts.ts";

export const reasoningChoices: { value: ReasoningEffort; description: string }[] = [
  { value: "default", description: "Use the model's default behavior" },
  { value: "none", description: "Disable optional reasoning when the model supports it" },
  { value: "minimal", description: "Smallest supported reasoning effort" },
  { value: "low", description: "Favor faster responses" },
  { value: "medium", description: "Balance reasoning and latency" },
  { value: "high", description: "Spend more effort on complex tasks" },
  { value: "xhigh", description: "Extra-high effort on models that support it" },
  { value: "max", description: "Maximum supported effort" },
];
export function createReasoningSetup(host: SetupHost) {
  async function save(reasoning: ReasoningEffort) {
    try {
      await host.apply({ kind: "reasoning", reasoning });
    } catch (error) {
      host.message(error instanceof Error ? error.message : "Could not save reasoning effort.");
    }
  }
  const choices = (): PanelChoice[] =>
    reasoningChoices.map((item) => ({
      label: `${host.settings()?.reasoning === item.value || (!host.settings()?.reasoning && item.value === "default") ? "✓ " : ""}${item.value}`,
      detail: item.description,
      select: () => save(item.value),
    }));
  return { save, choices };
}
