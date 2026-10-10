import type { ModelEvent, ModelRequest, ToolCall } from "@vcli/core";
import type { GenerateContentParameters } from "@google/genai";
import { abort, adapter, apiKey, count, metadata, object, objects, ProviderError, string, toolCall, type ProviderConfig, type ProviderDependencies, type ProviderTransport, type WireObject } from "./shared.ts";

function build(config: ProviderConfig, request: ModelRequest): WireObject {
  const contents: { role: string; parts: WireObject[] }[] = [];
  const originalCalls = new Map<string, { name: string; id?: string }>();
  for (const message of request.messages) {
    const data = metadata(message.providerData, config);
    for (const mapping of objects(data.calls)) originalCalls.set(string(mapping.id), { name: string(mapping.name), ...(string(mapping.originalId) ? { id: string(mapping.originalId) } : {}) });
    const role = message.role === "assistant" ? "model" : "user";
    let parts: WireObject[];
    if (message.role === "tool") {
      if (!message.toolCallId) throw new ProviderError("A tool result is missing its tool call ID.");
      const original = originalCalls.get(message.toolCallId);
      const name = original?.name || message.toolName;
      if (!name) throw new ProviderError("A Gemini tool result is missing its function name.");
      parts = [{ functionResponse: { name, ...(original?.id ? { id: original.id } : {}), response: { result: message.text } } }];
    } else if (message.role === "assistant" && Array.isArray(data.parts)) {
      // Keep signed parts exactly as received. Merging parts can invalidate their signatures.
      parts = objects(data.parts);
    } else {
      parts = message.text ? [{ text: message.text }] : [];
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.arguments } });
        originalCalls.set(call.id, { id: call.id, name: call.name });
      }
    }
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return {
    model: config.model, contents,
    config: {
      systemInstruction: request.system, maxOutputTokens: request.maxOutputTokens, candidateCount: 1,
      ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] } : {}),
    },
  };
}

async function* normalize(config: ProviderConfig, events: AsyncIterable<WireObject>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const parts: WireObject[] = [];
  const calls: ToolCall[] = [];
  const mappings: { id: string; name: string; originalId?: string }[] = [];
  let finish = "";
  let usage: WireObject = {};
  for await (const event of events) {
    abort(signal);
    if (event.error || object(event.promptFeedback).blockReason) throw new ProviderError("Gemini could not complete this request. No tool was executed.");
    if (event.usageMetadata) usage = object(event.usageMetadata);
    const candidate = objects(event.candidates).find(value => value.index === 0) ?? objects(event.candidates)[0];
    if (!candidate) continue;
    for (const raw of objects(object(candidate.content).parts)) {
      const part = structuredClone(raw);
      parts.push(part);
      if (typeof part.text === "string" && !part.thought && part.text) yield { type: "text", text: part.text };
      if (part.functionCall) {
        const fn = object(part.functionCall);
        if (fn.partialArgs || fn.willContinue) throw new ProviderError("Streaming partial Gemini function arguments are unsupported. No tool was executed.");
        const id = string(fn.id) || `gemini_${crypto.randomUUID()}`;
        const call = toolCall(id, fn.name, fn.args ?? {});
        calls.push(call);
        mappings.push({ id, name: call.name, ...(string(fn.id) ? { originalId: string(fn.id) } : {}) });
      }
    }
    if (candidate.finishReason) finish = string(candidate.finishReason);
  }
  if (finish !== "STOP") throw new ProviderError("The Gemini response did not complete. No tool was executed.");
  for (const call of calls) yield { type: "tool-call", call };
  yield { type: "usage", usage: {
    input: count(usage.promptTokenCount) + count(usage.toolUsePromptTokenCount),
    output: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
    cached: count(usage.cachedContentTokenCount),
  } };
  yield { type: "done", providerData: { provider: config.provider, model: config.model, parts, calls: mappings } };
}

export function geminiProvider(config: ProviderConfig, dependencies: ProviderDependencies) {
  const sdk = (): ProviderTransport => {
    let client: import("@google/genai").GoogleGenAI | undefined;
    return async (request, signal) => {
      const key = apiKey(config);
      const { GoogleGenAI } = await import("@google/genai");
      client ??= new GoogleGenAI({ apiKey: key, httpOptions: { baseUrl: config.baseURL, retryOptions: { attempts: 1 } } });
      const parameters = { ...request, config: { ...object(request.config), abortSignal: signal } } as unknown as GenerateContentParameters;
      return await client.models.generateContentStream(parameters) as unknown as AsyncIterable<WireObject>;
    };
  };
  return adapter(config, dependencies, request => build(config, request), (events, signal) => normalize(config, events, signal), sdk);
}
