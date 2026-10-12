import type { ReasoningEffort } from "@vcli/core";
import {
  ProviderError,
  REASONING_EFFORTS,
  type ProviderConfig,
  type WireObject,
} from "./shared.ts";

type Effort = Exclude<ReasoningEffort, "default">;

/** Reject known incompatible selections without model requests or key resolution. */
export function validateProviderReasoning(
  config: Pick<ProviderConfig, "provider" | "model" | "reasoning">,
): void {
  if (config.reasoning !== undefined && !REASONING_EFFORTS.includes(config.reasoning))
    throw new ProviderError("Unknown reasoning effort.");
  switch (config.provider) {
    case "openai":
      openaiReasoning(config);
      break;
    case "anthropic":
      anthropicReasoning(config);
      break;
    case "gemini":
      geminiReasoning(config);
      break;
    case "openrouter":
    case "compatible":
      chatReasoning(config);
      break;
  }
}

function selected(config: ProviderConfig): Effort | undefined {
  return config.reasoning && config.reasoning !== "default" ? config.reasoning : undefined;
}

function unsupported(config: ProviderConfig, explanation: string): never {
  throw new ProviderError(
    `Reasoning effort "${config.reasoning}" is unsupported for ${config.provider} model "${config.model}". ${explanation} Use default to leave the model settings unchanged.`,
  );
}

function validateOpenAI(config: ProviderConfig, model = config.model): void {
  const effort = selected(config);
  if (effort === "none" && /^gpt-6-astra(?:-|$)/.test(model))
    unsupported(config, "GPT-6 Astra requires reasoning.");
  if (["none", "minimal"].includes(effort ?? "") && /^gpt-6\.1-sol(?:-|$)/.test(model))
    unsupported(config, "GPT-6.1 Sol accepts low through max.");
}

export function openaiReasoning(config: ProviderConfig): WireObject {
  const effort = selected(config);
  if (!effort) return {};
  validateOpenAI(config);
  return { reasoning: { effort, ...(effort !== "none" ? { summary: "auto" } : {}) } };
}

export function chatReasoning(config: ProviderConfig): WireObject {
  const effort = selected(config);
  if (!effort) return {};
  if (config.provider === "openrouter") {
    const model = config.model.replace(/^[^/]+\//, "");
    validateOpenAI(config, model);
    // Avoid the gateway's nearest-effort fallback for known native model families.
    if (/^gemini-3(?:\.|-)/.test(model)) geminiReasoning({ ...config, model });
    if (model.startsWith("claude-")) anthropicReasoning({ ...config, model });
    return { reasoning: { effort }, provider: { require_parameters: true } };
  }
  return { reasoning_effort: effort };
}

export function anthropicReasoning(config: ProviderConfig): WireObject {
  const effort = selected(config);
  if (!effort) return {};
  if (effort === "minimal") unsupported(config, "Claude has no minimal effort level.");
  const model = config.model;
  if (effort === "none") {
    if (/^claude-(?:opus-5-5|sonnet-5-5|fable-|mythos-)/.test(model))
      unsupported(config, "This model requires thinking.");
    return { thinking: { type: "disabled" } };
  }
  if (/^claude-(?:sonnet|haiku)-4-[05]/.test(model))
    unsupported(config, "This model uses thinking token budgets rather than effort levels.");
  if (effort === "xhigh" && /^claude-(?:opus-4-6|sonnet-4-6)/.test(model))
    unsupported(config, "This model supports low, medium, high and max.");
  if (["xhigh", "max"].includes(effort) && /^claude-opus-4-5/.test(model))
    unsupported(config, "Claude Opus 4.5 supports low, medium and high.");
  const adaptive = /^claude-(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|haiku-5|fable-|mythos-)/.test(
    model,
  );
  return {
    output_config: { effort },
    ...(adaptive ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  };
}

export function geminiReasoning(config: ProviderConfig): WireObject {
  const effort = selected(config);
  if (!effort) return {};
  if (effort === "none" && /^gemini-2\.5-flash(?:-|$)/.test(config.model))
    return { thinkingConfig: { thinkingBudget: 0 } };
  if (["none", "xhigh", "max"].includes(effort))
    unsupported(
      config,
      "This Gemini adapter supports minimal, low, medium and high thinking levels.",
    );
  if (!/^gemini-3(?:\.|-)/.test(config.model))
    unsupported(
      config,
      "The GenerateContent API exposes effort levels for Gemini 3; earlier models use token budgets.",
    );
  if (["minimal", "medium"].includes(effort) && /^gemini-3-pro(?:-|$)/.test(config.model))
    unsupported(config, "Gemini 3 Pro supports low and high.");
  if (effort === "minimal" && /^gemini-3\.1-pro(?:-|$)/.test(config.model))
    unsupported(config, "Gemini 3.1 Pro supports low, medium and high.");
  return { thinkingConfig: { thinkingLevel: effort.toUpperCase(), includeThoughts: true } };
}
