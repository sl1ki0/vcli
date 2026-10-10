import { anthropicProvider } from "./anthropic.ts";
import { geminiProvider } from "./gemini.ts";
import { openaiProvider } from "./openai.ts";
import type { ProviderAdapter } from "@vcli/core";
import type { ProviderConfig, ProviderDependencies } from "./shared.ts";

export type { ProviderConfig, ProviderDependencies, ProviderTransport, WireObject } from "./shared.ts";
export { ProviderError } from "./shared.ts";

export function createProvider(config: ProviderConfig, dependencies: ProviderDependencies = {}): ProviderAdapter {
  switch (config.provider) {
    case "openai": case "compatible": return openaiProvider(config, dependencies);
    case "anthropic": return anthropicProvider(config, dependencies);
    case "gemini": return geminiProvider(config, dependencies);
    default: throw new Error(`Unsupported provider: ${String(config.provider)}`);
  }
}
