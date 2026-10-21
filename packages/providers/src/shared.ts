import type {
  ModelEvent,
  ModelRequest,
  ProviderAdapter,
  ReasoningEffort,
  ToolCall,
} from "@vcli/core";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_PROVIDER_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  openrouter: OPENROUTER_BASE_URL,
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
} as const;
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ProviderConfig {
  provider: "openai" | "anthropic" | "gemini" | "openrouter" | "compatible";
  model: string;
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
  reasoning?: ReasoningEffort;
}

export type WireObject = Record<string, unknown>;
export type ProviderTransport = (
  request: WireObject,
  signal: AbortSignal,
) => Promise<AsyncIterable<WireObject>>;
export interface ProviderDependencies {
  /** Replaces only the SDK/network boundary; request mapping and normalization still run. */
  transport?: ProviderTransport;
  /** Injectable HTTP boundary for the official provider SDKs. */
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

class ProviderResponseLimitError extends ProviderError {}

/** Limit decoded bytes before provider SDKs buffer JSON, SSE frames, or error bodies. */
export function boundedProviderFetch(
  fetcher: typeof fetch = fetch,
  maxBytes = 16 * 1024 * 1024,
): typeof fetch {
  return (async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body) return response;
    const tooLarge = () =>
      new ProviderResponseLimitError(
        `Model response exceeded its ${maxBytes}-byte transport limit.`,
      );
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) return controller.close();
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) {
            controller.error(tooLarge());
            await reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

export function object(value: unknown): WireObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as WireObject)
    : {};
}
export function objects(value: unknown): WireObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
export function toolCall(id: unknown, name: unknown, argumentsValue: unknown): ToolCall {
  let args: unknown = argumentsValue;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args || "{}");
    } catch {
      throw new ProviderError("The model returned invalid tool arguments. No tool was executed.");
    }
  }
  if (
    !string(id) ||
    !string(name) ||
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    throw new ProviderError("The model returned an invalid tool call. No tool was executed.");
  }
  return { id: string(id), name: string(name), arguments: args as Record<string, unknown> };
}

export function metadata(value: unknown, config: ProviderConfig): WireObject {
  const data = object(value);
  return data.provider === config.provider && data.model === config.model ? data : {};
}

export function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Model request cancelled", "AbortError");
}

export async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  abort(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new DOMException("Model request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof ProviderError) return false;
  const e = object(error);
  const status = count(e.status ?? e.statusCode ?? e.code);
  return (
    [408, 409, 429].includes(status) ||
    status >= 500 ||
    ["APIConnectionError", "APIConnectionTimeoutError"].includes(string(e.name))
  );
}

/** Retry model requests only before the first delivered event, never a partial answer or tools. */
export function adapter(
  config: ProviderConfig,
  dependencies: ProviderDependencies,
  build: (request: ModelRequest) => WireObject,
  normalize: (events: AsyncIterable<WireObject>, signal: AbortSignal) => AsyncIterable<ModelEvent>,
  sdkTransport: () => ProviderTransport,
): ProviderAdapter {
  if (!config.model.trim()) throw new ProviderError("A model name is required.");
  if (config.reasoning !== undefined && !REASONING_EFFORTS.includes(config.reasoning))
    throw new ProviderError("Unknown reasoning effort.");
  if (
    config.contextWindow !== undefined &&
    (!Number.isInteger(config.contextWindow) || config.contextWindow < 1024)
  ) {
    throw new ProviderError("contextWindow must be an integer of at least 1024 tokens.");
  }
  const transport = dependencies.transport ?? sdkTransport();
  return {
    id: config.provider,
    model: config.model,
    // Unknown model windows must be configurable rather than inferred from a model name.
    contextWindow: config.contextWindow ?? 32_768,
    async *stream(request, signal) {
      abort(signal);
      const input = build(request);
      for (let attempt = 0; ; attempt++) {
        let delivered = false;
        try {
          const events = await transport(input, signal);
          for await (const event of normalize(events, signal)) {
            abort(signal);
            delivered = true;
            yield event;
          }
          return;
        } catch (error) {
          abort(signal);
          // SDKs can wrap fetch failures as connection errors; a size violation is never retryable.
          let cause: unknown = error;
          for (let depth = 0; depth < 5; depth++) {
            if (cause instanceof ProviderResponseLimitError) throw cause;
            cause = object(cause).cause;
          }
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          if (attempt < 2 && !delivered && retryable(error)) {
            await (dependencies.sleep ?? delay)([250, 1000][attempt]!, signal);
            continue;
          }
          if (error instanceof ProviderError) throw error;
          const status =
            count(object(error).status ?? object(error).statusCode ?? object(error).code) ||
            undefined;
          if (status === 400 && config.reasoning && config.reasoning !== "default")
            throw new ProviderError(
              `${config.provider} rejected the request with reasoning effort "${config.reasoning}" (HTTP 400). Select a supported effort or use default; check the selected model and request settings.`,
              status,
            );
          // SDK messages and causes can contain URLs, request bodies, and credentials.
          throw new ProviderError(
            `${config.provider} model request failed${status ? ` (HTTP ${status})` : ""}. Check the provider settings and connection.`,
            status,
          );
        }
      }
    },
  };
}

/** Environment credentials must never follow an endpoint selected by a project. */
export function credentialEnvironmentVariables(
  config: Pick<ProviderConfig, "provider" | "baseURL">,
): string[] {
  const endpoint = (value: string): string => {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid credential endpoint");
    return url.href.replace(/\/+$/, "");
  };
  try {
    if (config.provider === "compatible") {
      const bound = process.env.VCLI_COMPATIBLE_BASE_URL;
      if (!config.baseURL || !bound || endpoint(config.baseURL) !== endpoint(bound)) return [];
    } else if (
      config.baseURL &&
      endpoint(config.baseURL) !== endpoint(DEFAULT_PROVIDER_ENDPOINTS[config.provider])
    )
      return [];
  } catch {
    return [];
  }
  return config.provider === "gemini"
    ? ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    : config.provider === "anthropic"
      ? ["ANTHROPIC_API_KEY"]
      : config.provider === "openrouter"
        ? ["OPENROUTER_API_KEY"]
        : config.provider === "compatible"
          ? ["VCLI_COMPATIBLE_API_KEY"]
          : ["OPENAI_API_KEY"];
}

export function isLocalEndpoint(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function apiKey(config: ProviderConfig): string {
  const variables = credentialEnvironmentVariables(config);
  const key = config.apiKey || variables.map((name) => process.env[name]).find(Boolean);
  if (key) return key;
  // Local/OpenAI-compatible services frequently run without authentication.
  if (config.provider === "compatible" && isLocalEndpoint(config.baseURL)) return "vcli-local";
  const setup = variables.length
    ? `Set ${variables[0]} or supply apiKey in the provider configuration.`
    : "Supply an API key explicitly for this endpoint.";
  throw new ProviderError(`No ${config.provider} API key configured. ${setup}`);
}
