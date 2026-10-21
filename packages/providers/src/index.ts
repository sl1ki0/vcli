import { anthropicProvider } from "./anthropic.ts";
import { geminiProvider } from "./gemini.ts";
import { openaiProvider } from "./openai.ts";
import type { ProviderAdapter } from "@vcli/core";
import type { ProviderConfig, ProviderDependencies } from "./shared.ts";
import { validateProviderReasoning } from "./reasoning.ts";

export type {
  ProviderConfig,
  ProviderDependencies,
  ProviderTransport,
  WireObject,
} from "./shared.ts";
export {
  ProviderError,
  OPENROUTER_BASE_URL,
  DEFAULT_PROVIDER_ENDPOINTS,
  REASONING_EFFORTS,
  credentialEnvironmentVariables,
  isLocalEndpoint,
} from "./shared.ts";
export { validateProviderReasoning } from "./reasoning.ts";

export function createProvider(
  config: ProviderConfig,
  dependencies: ProviderDependencies = {},
): ProviderAdapter {
  validateProviderReasoning(config);
  switch (config.provider) {
    case "openai":
    case "compatible":
    case "openrouter":
      return openaiProvider(config, dependencies);
    case "anthropic":
      return anthropicProvider(config, dependencies);
    case "gemini":
      return geminiProvider(config, dependencies);
    default:
      throw new Error(`Unsupported provider: ${String(config.provider)}`);
  }
}
