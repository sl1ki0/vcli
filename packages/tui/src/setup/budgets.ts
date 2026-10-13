import { createSignal } from "solid-js";
import { balanced, type ContextSettings } from "@vcli/core";
import type { PanelChoice, PanelInput, SetupHost } from "./contracts.ts";

type BudgetKey = keyof ContextSettings | "contextWindow";
const fields: { key: BudgetKey; label: string; hint: string }[] = [
  {
    key: "contextWindow",
    label: "Model context window",
    hint: "The model's total input/output capacity. Check its provider documentation.",
  },
  {
    key: "promptTokens",
    label: "Prompt budget",
    hint: "Target input budget. Effective ceiling is min(prompt budget, context window minus output reserve).",
  },
  {
    key: "mapTokens",
    label: "Repository map",
    hint: "Budget for module signatures and dependency relationships.",
  },
  {
    key: "schemaTokens",
    label: "Tool schemas",
    hint: "Budget for eager and discovered tool schemas.",
  },
  {
    key: "resultTokens",
    label: "Tool result",
    hint: "Maximum estimated tokens kept per tool result; full artifacts remain available.",
  },
  {
    key: "outputTokens",
    label: "Output reserve",
    hint: "Maximum output per call, reserved within the context window.",
  },
  { key: "maxTurns", label: "Maximum turns", hint: "Maximum model/tool rounds per task." },
  {
    key: "taskTokens",
    label: "Total task budget",
    hint: "Optional total input + output limit. Enter off to remove the limit.",
  },
];

export function createBudgetSetup(host: SetupHost) {
  const [draft, setDraft] = createSignal({ contextWindow: 32_768, context: { ...balanced } });
  const [field, setField] = createSignal<BudgetKey>();
  function begin() {
    const current = host.settings();
    setDraft({
      contextWindow: current?.contextWindow ?? 32_768,
      context: { ...(current?.context ?? balanced) },
    });
    setField(undefined);
  }
  const valueFor = (key: BudgetKey) =>
    key === "contextWindow" ? draft().contextWindow : draft().context[key];
  function input(): PanelInput | undefined {
    const selected = fields.find(({ key }) => key === field());
    if (selected)
      return {
        label: selected.label,
        value: String(valueFor(selected.key) ?? ""),
        placeholder: selected.key === "taskTokens" ? "off" : "Positive whole number",
        hint: selected.hint,
      };
  }
  function submit(text: string) {
    const key = field();
    if (!key) return;
    const off = key === "taskTokens" && (!text.trim() || text.trim().toLowerCase() === "off");
    const value = Number(text);
    if (!off && (!Number.isSafeInteger(value) || value <= 0)) {
      host.message("Enter a positive whole number.");
      return;
    }
    if ((key === "contextWindow" || key === "promptTokens") && value < 1024) {
      host.message("Context window and prompt budget must be at least 1,024.");
      return;
    }
    setDraft((previous) => {
      const context = { ...previous.context };
      if (key === "contextWindow") return { ...previous, contextWindow: value };
      if (off) delete context.taskTokens;
      else context[key] = value;
      return { ...previous, context };
    });
    host.message("");
    setField(undefined);
  }
  async function save() {
    if (draft().contextWindow - draft().context.outputTokens < 1024) {
      host.message("Output reserve must leave at least 1,024 tokens in the model context window.");
      return;
    }
    try {
      await host.apply({ kind: "budgets", ...draft() });
    } catch (error) {
      host.message(error instanceof Error ? error.message : "Could not save token budgets.");
    }
  }
  function choices(): PanelChoice[] {
    if (field()) return [];
    return [
      ...fields.map(({ key, label }) => ({
        label: `${label}: ${valueFor(key)?.toLocaleString("en-US") ?? "off"}`,
        select: () => {
          host.message("");
          setField(key);
        },
      })),
      { label: "Save token budgets", detail: "Apply these limits to this project.", select: save },
    ];
  }
  return { begin, field, input, submit, choices };
}
