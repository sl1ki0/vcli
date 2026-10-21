import type { ModelEvent, ModelRequest } from "@vcli/core";
import type AnthropicClient from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import {
  abort,
  adapter,
  apiKey,
  boundedProviderFetch,
  DEFAULT_PROVIDER_ENDPOINTS,
  count,
  metadata,
  object,
  objects,
  ProviderError,
  string,
  toolCall,
  type ProviderConfig,
  type ProviderDependencies,
  type ProviderTransport,
  type WireObject,
} from "./shared.ts";
import { anthropicReasoning } from "./reasoning.ts";

function build(config: ProviderConfig, request: ModelRequest): WireObject {
  const messages: { role: string; content: WireObject[] }[] = [];
  for (const message of request.messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    let content: WireObject[];
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ProviderError("A tool result is missing its tool call ID.");
      content = [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.text }];
    } else if (
      message.role === "assistant" &&
      Array.isArray(metadata(message.providerData, config).content)
    ) {
      content = objects(metadata(message.providerData, config).content);
    } else {
      content = message.text ? [{ type: "text", text: message.text }] : [];
      for (const call of message.toolCalls ?? [])
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    if (!content.length) continue;
    const previous = messages.at(-1);
    // Parallel tool results must all be in the user message immediately after tool_use.
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    model: config.model,
    max_tokens: request.maxOutputTokens,
    stream: true,
    ...anthropicReasoning(config),
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
}

async function* normalize(
  config: ProviderConfig,
  events: AsyncIterable<WireObject>,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const blocks = new Map<number, WireObject>();
  const inputJson = new Map<number, string>();
  let usage: WireObject = {};
  let stopReason = "";
  let completed = false;
  for await (const event of events) {
    abort(signal);
    const index = count(event.index);
    if (event.type === "message_start") {
      usage = object(object(event.message).usage);
    } else if (event.type === "content_block_start") {
      const block = structuredClone(object(event.content_block));
      blocks.set(index, block);
      if (block.type === "text" && string(block.text))
        yield { type: "text", text: string(block.text) };
      else if (block.type === "thinking" && string(block.thinking))
        yield { type: "reasoning", text: string(block.thinking) };
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(index);
      if (!block)
        throw new ProviderError("Anthropic returned a content delta without a content block.");
      const delta = object(event.delta);
      if (delta.type === "text_delta") {
        block.text = string(block.text) + string(delta.text);
        yield { type: "text", text: string(delta.text) };
      } else if (delta.type === "input_json_delta")
        inputJson.set(index, (inputJson.get(index) ?? "") + string(delta.partial_json));
      else if (delta.type === "thinking_delta") {
        block.thinking = string(block.thinking) + string(delta.thinking);
        if (string(delta.thinking)) yield { type: "reasoning", text: string(delta.thinking) };
      } else if (delta.type === "signature_delta")
        block.signature = string(block.signature) + string(delta.signature);
      else if (delta.type === "citations_delta")
        block.citations = [...objects(block.citations), object(delta.citation)];
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(index);
      if (block?.type === "tool_use" && inputJson.has(index))
        block.input = toolCall(block.id, block.name, inputJson.get(index)).arguments;
    } else if (event.type === "message_delta") {
      usage = { ...usage, ...object(event.usage) };
      stopReason = string(object(event.delta).stop_reason) || stopReason;
    } else if (event.type === "message_stop") completed = true;
    else if (event.type === "error")
      throw new ProviderError("Anthropic returned a stream error. No tool was executed.");
  }
  if (!completed || !["end_turn", "tool_use", "stop_sequence"].includes(stopReason))
    throw new ProviderError("The Anthropic response did not complete. No tool was executed.");
  const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  const calls = content
    .filter((block) => block.type === "tool_use")
    .map((block) => toolCall(block.id, block.name, block.input));
  for (const call of calls) yield { type: "tool-call", call };
  yield {
    type: "usage",
    usage: {
      input:
        count(usage.input_tokens) +
        count(usage.cache_creation_input_tokens) +
        count(usage.cache_read_input_tokens),
      output: count(usage.output_tokens),
      cached: count(usage.cache_read_input_tokens),
    },
  };
  yield { type: "done", providerData: { provider: config.provider, model: config.model, content } };
}

export function anthropicProvider(config: ProviderConfig, dependencies: ProviderDependencies) {
  const sdk = (): ProviderTransport => {
    let client: AnthropicClient | undefined;
    return async (request, signal) => {
      const key = apiKey(config);
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client ??= new Anthropic({
        apiKey: key,
        baseURL: config.baseURL ?? DEFAULT_PROVIDER_ENDPOINTS.anthropic,
        maxRetries: 0,
        fetch: boundedProviderFetch(dependencies.fetch),
      });
      return (await client.messages.create(request as unknown as MessageCreateParamsStreaming, {
        signal,
      })) as unknown as AsyncIterable<WireObject>;
    };
  };
  return adapter(
    config,
    dependencies,
    (request) => build(config, request),
    (events, signal) => normalize(config, events, signal),
    sdk,
  );
}
