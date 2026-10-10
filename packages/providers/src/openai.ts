import type { ModelEvent, ModelRequest } from "@vcli/core";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import {
  abort,
  adapter,
  apiKey,
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

function responsesRequest(config: ProviderConfig, request: ModelRequest): WireObject {
  const input: WireObject[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ProviderError("A tool result is missing its tool call ID.");
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.text,
      });
    } else if (message.role === "assistant") {
      const output = metadata(message.providerData, config).output;
      if (Array.isArray(output) && output.length) input.push(...objects(output));
      else {
        if (message.text) input.push({ role: "assistant", content: message.text });
        for (const call of message.toolCalls ?? [])
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
      }
    } else input.push({ role: "user", content: message.text });
  }
  return {
    model: config.model,
    instructions: request.system,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: request.maxOutputTokens,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
  };
}

async function* normalizeResponses(
  config: ProviderConfig,
  events: AsyncIterable<WireObject>,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const output = new Map<number, WireObject>();
  let completed = false;
  for await (const event of events) {
    abort(signal);
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta")
      yield { type: "text", text: string(event.delta) };
    else if (event.type === "response.output_item.done")
      output.set(count(event.output_index), object(event.item));
    else if (event.type === "response.completed") {
      const response = object(event.response);
      const items = Array.isArray(response.output)
        ? objects(response.output)
        : [...output.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
      const usage = object(response.usage);
      // Tools are delivered only after a successful complete response.
      const calls = items
        .filter((item) => item.type === "function_call")
        .map((item) => toolCall(item.call_id, item.name, item.arguments));
      for (const call of calls) yield { type: "tool-call", call };
      yield {
        type: "usage",
        usage: {
          input: count(usage.input_tokens),
          output: count(usage.output_tokens),
          cached: count(object(usage.input_tokens_details).cached_tokens),
        },
      };
      yield {
        type: "done",
        providerData: { provider: config.provider, model: config.model, output: items },
      };
      completed = true;
    } else if (["response.failed", "response.incomplete", "error"].includes(string(event.type))) {
      throw new ProviderError("The OpenAI response did not complete. No tool was executed.");
    }
  }
  if (!completed) throw new ProviderError("The OpenAI response stream ended before completion.");
}

function chatRequest(config: ProviderConfig, request: ModelRequest): WireObject {
  const messages: WireObject[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ProviderError("A tool result is missing its tool call ID.");
      messages.push({ role: "tool", content: message.text, tool_call_id: message.toolCallId });
    } else {
      const entry: WireObject = {
        role: message.role,
        content: message.text || (message.toolCalls?.length ? null : ""),
      };
      if (message.toolCalls?.length)
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      messages.push(entry);
    }
  }
  return {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxOutputTokens,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

async function* normalizeChat(
  events: AsyncIterable<WireObject>,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish = "";
  let usage: WireObject = {};
  for await (const event of events) {
    abort(signal);
    if (event.error) throw new ProviderError("The compatible provider returned a stream error.");
    if (event.usage) usage = object(event.usage);
    const choice =
      objects(event.choices).find((value) => value.index === 0) ?? objects(event.choices)[0];
    if (!choice) continue;
    const delta = object(choice.delta);
    if (typeof delta.content === "string" && delta.content)
      yield { type: "text", text: delta.content };
    for (const part of objects(delta.tool_calls)) {
      const index = count(part.index);
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      const fn = object(part.function);
      call.id += string(part.id);
      call.name += string(fn.name);
      call.arguments += string(fn.arguments);
      calls.set(index, call);
    }
    if (choice.finish_reason) finish = string(choice.finish_reason);
  }
  if (!["stop", "tool_calls"].includes(finish))
    throw new ProviderError("The compatible response did not complete. No tool was executed.");
  const completeCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => toolCall(call.id, call.name, call.arguments));
  for (const call of completeCalls) yield { type: "tool-call", call };
  yield {
    type: "usage",
    usage: {
      input: count(usage.prompt_tokens),
      output: count(usage.completion_tokens),
      cached: count(object(usage.prompt_tokens_details).cached_tokens),
    },
  };
  yield { type: "done" };
}

export function openaiProvider(config: ProviderConfig, dependencies: ProviderDependencies) {
  const compatible = config.provider === "compatible";
  const sdk = (): ProviderTransport => {
    let client: import("openai").default | undefined;
    return async (request, signal) => {
      if (compatible && !config.baseURL)
        throw new ProviderError("An OpenAI-compatible provider requires baseURL.");
      const key = apiKey(config);
      const { default: OpenAI } = await import("openai");
      client ??= new OpenAI({ apiKey: key, baseURL: config.baseURL, maxRetries: 0 });
      const stream = compatible
        ? await client.chat.completions.create(
            request as unknown as ChatCompletionCreateParamsStreaming,
            { signal },
          )
        : await client.responses.create(request as unknown as ResponseCreateParamsStreaming, {
            signal,
          });
      return stream as unknown as AsyncIterable<WireObject>;
    };
  };
  return adapter(
    config,
    dependencies,
    (request) => (compatible ? chatRequest(config, request) : responsesRequest(config, request)),
    (events, signal) =>
      compatible ? normalizeChat(events, signal) : normalizeResponses(config, events, signal),
    sdk,
  );
}
