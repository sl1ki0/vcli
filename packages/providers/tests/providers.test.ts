import { describe, expect, test } from "bun:test";
import type { ModelEvent, ModelRequest, ProviderAdapter } from "@vcli/core";
import { createProvider, ProviderError, type ProviderConfig, type ProviderTransport, type WireObject } from "../src/index.ts";

const request: ModelRequest = {
  system: "Inspect the architecture.", messages: [{ role: "user", text: "Find imports." }], maxOutputTokens: 512,
  tools: [{ name: "find_imports", description: "Find imported modules", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
};
async function* wire(events: WireObject[]) { for (const event of events) yield event; }
function fake(provider: ProviderConfig["provider"], events: WireObject[]) {
  const inputs: WireObject[] = [];
  const adapter = createProvider({ provider, model: "test-model", contextWindow: 8192 }, {
    transport: async input => { inputs.push(input); return wire(events); },
  });
  return { adapter, inputs };
}
async function collect(provider: ProviderAdapter, input = request, signal = new AbortController().signal) {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(input, signal)) events.push(event);
  return events;
}
const responseOutput = [
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-final" },
  { type: "function_call", id: "fc_1", call_id: "call_1", name: "find_imports", arguments: '{"path":"src"}', status: "completed" },
];
const openaiEvents: WireObject[] = [
  { type: "response.output_text.delta", delta: "Checking." },
  { type: "response.output_item.added", output_index: 0, item: { ...responseOutput[0], encrypted_content: "unfinished" } },
  { type: "response.output_item.done", output_index: 0, item: responseOutput[0] },
  { type: "response.output_item.done", output_index: 1, item: responseOutput[1] },
  { type: "response.completed", response: { output: responseOutput, usage: { input_tokens: 40, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } } } },
];

describe("OpenAI Responses adapter", () => {
  test("normalizes text, complete calls, usage, and encrypted continuation", async () => {
    const { adapter, inputs } = fake("openai", openaiEvents);
    const events = await collect(adapter);
    expect(events).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool-call", call: { id: "call_1", name: "find_imports", arguments: { path: "src" } } },
      { type: "usage", usage: { input: 40, output: 10, cached: 20 } },
      { type: "done", providerData: { provider: "openai", model: "test-model", output: responseOutput } },
    ]);
    expect(inputs[0]).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 512 });
    expect((inputs[0]!.tools as WireObject[])[0]).toMatchObject({ parameters: request.tools[0]!.inputSchema, strict: false });
  });
  test("replays output items once and maps tool result to call_id", async () => {
    const { adapter, inputs } = fake("openai", openaiEvents);
    const events = await collect(adapter);
    const done = events.at(-1)!;
    const call = { id: "call_1", name: "find_imports", arguments: { path: "src" } };
    await collect(adapter, { ...request, messages: [request.messages[0]!, { role: "assistant", text: "Checking.", toolCalls: [call], providerData: done.type === "done" ? done.providerData : undefined }, { role: "tool", toolCallId: call.id, text: "[]" }] });
    expect(inputs[1]!.input).toEqual([{ role: "user", content: "Find imports." }, ...responseOutput, { type: "function_call_output", call_id: "call_1", output: "[]" }]);
  });
  test("does not dispatch calls from an incomplete stream", async () => {
    const { adapter } = fake("openai", [{ type: "response.output_item.done", item: responseOutput[1], output_index: 0 }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]);
    const delivered: ModelEvent[] = [];
    await expect((async () => { for await (const event of adapter.stream(request, new AbortController().signal)) delivered.push(event); })()).rejects.toThrow("did not complete");
    expect(delivered).toEqual([]);
  });
  test("rejects malformed arguments", async () => {
    const { adapter } = fake("openai", [{ type: "response.completed", response: { output: [{ ...responseOutput[1], arguments: "[1]" }] } }]);
    await expect(collect(adapter)).rejects.toThrow("invalid tool call");
  });
  test("validates a whole tool batch before delivering any call", async () => {
    const { adapter } = fake("openai", [{ type: "response.completed", response: { output: [responseOutput[1], { ...responseOutput[1], call_id: "bad", arguments: "{" }] } }]);
    const delivered: ModelEvent[] = [];
    await expect((async () => { for await (const event of adapter.stream(request, new AbortController().signal)) delivered.push(event); })()).rejects.toThrow("invalid tool arguments");
    expect(delivered).toEqual([]);
  });
  test("displays a model refusal as text", async () => {
    const { adapter } = fake("openai", [{ type: "response.refusal.delta", delta: "I cannot do that." }, { type: "response.completed", response: { output: [] } }]);
    expect((await collect(adapter))[0]).toEqual({ type: "text", text: "I cannot do that." });
  });
});

describe("OpenAI-compatible Chat Completions adapter", () => {
  test("assembles interleaved tool deltas and trailing usage", async () => {
    const { adapter, inputs } = fake("compatible", [
      { choices: [{ index: 0, delta: { content: "Inspecting", tool_calls: [{ index: 1, id: "b", function: { name: "find_imports", arguments: '{"path":' } }, { index: 0, id: "a", function: { name: "find_imports", arguments: '{"path":"src"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"test"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } } },
    ]);
    const events = await collect(adapter);
    expect(events.filter(event => event.type === "tool-call")).toEqual([
      { type: "tool-call", call: { id: "a", name: "find_imports", arguments: { path: "src" } } },
      { type: "tool-call", call: { id: "b", name: "find_imports", arguments: { path: "test" } } },
    ]);
    expect(events.at(-2)).toEqual({ type: "usage", usage: { input: 50, output: 12, cached: 5 } });
    expect(inputs[0]).toMatchObject({ max_tokens: 512, stream_options: { include_usage: true } });
  });
  test("rejects tool arguments cut off by length", async () => {
    const { adapter } = fake("compatible", [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "find_imports", arguments: '{"path":' } }] }, finish_reason: "length" }] }]);
    await expect(collect(adapter)).rejects.toThrow("did not complete");
  });
});

const anthropicEvents: WireObject[] = [
  { type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 20 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private reasoning" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "find_imports", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"src"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  { type: "message_delta", delta: {}, usage: { output_tokens: 9 } },
  { type: "message_stop" },
];
describe("Anthropic adapter", () => {
  test("preserves signed thinking without displaying it and counts cumulative usage once", async () => {
    const { adapter, inputs } = fake("anthropic", anthropicEvents);
    const events = await collect(adapter);
    expect(events.filter(event => event.type === "text")).toEqual([]);
    expect(events.at(-2)).toEqual({ type: "usage", usage: { input: 33, output: 9, cached: 20 } });
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", providerData: { content: [{ type: "thinking", thinking: "private reasoning", signature: "signed" }, { type: "tool_use", input: { path: "src" } }] } });
    await collect(adapter, { ...request, messages: [request.messages[0]!, { role: "assistant", text: "", providerData: done.type === "done" ? done.providerData : undefined }, { role: "tool", text: "A", toolCallId: "tool_1" }, { role: "tool", text: "B", toolCallId: "tool_2" }] });
    expect((inputs[1]!.messages as WireObject[]).at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "A" }, { type: "tool_result", tool_use_id: "tool_2", content: "B" }] });
  });
  test("requires message_stop and successful stop reason", async () => {
    const { adapter } = fake("anthropic", anthropicEvents.slice(0, -1));
    await expect(collect(adapter)).rejects.toThrow("did not complete");
  });
});

describe("Gemini adapter", () => {
  test("keeps function thought signature attached and maps a missing provider ID correctly", async () => {
    const signed = { functionCall: { name: "find_imports", args: { path: "src" } }, thoughtSignature: "opaque-signature" };
    const { adapter, inputs } = fake("gemini", [
      { candidates: [{ index: 0, content: { parts: [{ text: "private", thought: true }] } }] },
      { candidates: [{ index: 0, content: { parts: [{ text: "Inspecting." }, signed] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4, thoughtsTokenCount: 6, cachedContentTokenCount: 12 } },
    ]);
    const events = await collect(adapter);
    expect(events.filter(event => event.type === "text")).toEqual([{ type: "text", text: "Inspecting." }]);
    expect(events.at(-2)).toEqual({ type: "usage", usage: { input: 30, output: 10, cached: 12 } });
    const call = events.find(event => event.type === "tool-call");
    const done = events.at(-1)!;
    expect(call?.type).toBe("tool-call");
    await collect(adapter, { ...request, messages: [request.messages[0]!, { role: "assistant", text: "Inspecting.", providerData: done.type === "done" ? done.providerData : undefined }, { role: "tool", text: "[]", toolCallId: call?.type === "tool-call" ? call.call.id : "", toolName: "find_imports" }] });
    const contents = inputs[1]!.contents as { role: string; parts: WireObject[] }[];
    expect(contents[1]!.parts).toEqual([{ text: "private", thought: true }, { text: "Inspecting." }, signed]);
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "find_imports", response: { result: "[]" } } }]);
    expect((inputs[0]!.config as { tools: { functionDeclarations: WireObject[] }[] }).tools[0]!.functionDeclarations[0]!.parametersJsonSchema).toEqual(request.tools[0]!.inputSchema);
  });
  test("returns provider-assigned IDs on function responses", async () => {
    const { adapter, inputs } = fake("gemini", [{ candidates: [{ content: { parts: [{ functionCall: { id: "native", name: "find_imports", args: {} }, thoughtSignature: "sig" }] }, finishReason: "STOP" }] }]);
    const events = await collect(adapter);
    const done = events.at(-1)!;
    await collect(adapter, { ...request, messages: [{ role: "assistant", text: "", providerData: done.type === "done" ? done.providerData : undefined }, { role: "tool", text: "result", toolCallId: "native" }] });
    expect((inputs[1]!.contents as { parts: WireObject[] }[])[1]!.parts[0]).toEqual({ functionResponse: { name: "find_imports", id: "native", response: { result: "result" } } });
  });
});

describe("provider request lifecycle", () => {
  test("retries transient model failures at most twice before delivery", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const transport: ProviderTransport = async () => { attempts++; if (attempts < 3) throw { status: 429, message: "secret" }; return wire(openaiEvents); };
    const adapter = createProvider({ provider: "openai", model: "test-model" }, { transport, sleep: async ms => { sleeps.push(ms); } });
    await collect(adapter);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 1000]);
  });
  test("does not retry after text delivery or leak SDK error details", async () => {
    let attempts = 0;
    const adapter = createProvider({ provider: "openai", model: "test-model" }, { transport: async () => { attempts++; return (async function* () { yield { type: "response.output_text.delta", delta: "Started" }; throw { status: 500, message: "Authorization: secret-key" }; })(); } });
    await expect(collect(adapter)).rejects.toThrow("HTTP 500");
    expect(attempts).toBe(1);
    try { await collect(adapter); } catch (error) { expect(String(error)).not.toContain("secret-key"); }
  });
  test("honors cancellation before inference and between stream events", async () => {
    let network = false;
    const signal = new AbortController();
    signal.abort();
    const adapter = createProvider({ provider: "openai", model: "test-model" }, { transport: async () => { network = true; return wire(openaiEvents); } });
    await expect(collect(adapter, request, signal.signal)).rejects.toThrow("cancelled");
    expect(network).toBe(false);
    const controller = new AbortController();
    const midstream = createProvider({ provider: "openai", model: "test-model" }, { transport: async (_, provided) => {
      expect(provided).toBe(controller.signal);
      return (async function* () { yield openaiEvents[0]!; controller.abort(); yield openaiEvents.at(-1)!; })();
    } });
    await expect(collect(midstream, request, controller.signal)).rejects.toThrow("cancelled");
  });
  test("constructs without credentials and reports missing keys only at inference", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const adapter = createProvider({ provider: "openai", model: "test-model" });
      expect(adapter.id).toBe("openai");
      await expect(collect(adapter)).rejects.toThrow("Set OPENAI_API_KEY");
    } finally { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; }
  });
  test("rejects invalid context window configuration", () => {
    expect(() => createProvider({ provider: "openai", model: "test-model", contextWindow: 0 })).toThrow(ProviderError);
  });
});

describe("official SDK wire integration", () => {
  const fixtures: [ProviderConfig["provider"], string, WireObject[]][] = [
    ["openai", "/responses", [{ type: "response.output_text.delta", delta: "Ready" }, { type: "response.completed", response: { output: [], usage: { input_tokens: 3, output_tokens: 1 } } }]],
    ["compatible", "/chat/completions", [{ choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]],
    ["anthropic", "/v1/messages", [{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]],
    ["gemini", "/v1beta/models/test-model:streamGenerateContent", [{ candidates: [{ content: { parts: [{ text: "Ready" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }]],
  ];
  for (const [provider, endpoint, events] of fixtures) {
    test(`${provider} SDK sends a real streaming request to a local fixture`, async () => {
      const captures: { path: string; body: WireObject }[] = [];
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
        captures.push({ path: new URL(req.url).pathname, body: await req.json() as WireObject });
        const payload = events.map(event => `${provider === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(payload + (provider === "compatible" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
      } });
      try {
        const adapter = createProvider({ provider, model: "test-model", apiKey: "fixture-key", baseURL: server.url.origin });
        const normalized = await collect(adapter);
        expect(normalized[0]).toEqual({ type: "text", text: "Ready" });
        expect(normalized.at(-2)).toEqual({ type: "usage", usage: { input: 3, output: 1, cached: 0 } });
        expect(captures).toHaveLength(1);
        expect(captures[0]!.path).toBe(endpoint);
        expect(JSON.stringify(captures[0]!.body)).not.toContain("fixture-key");
      } finally { server.stop(true); }
    });
    test(`${provider} SDK cancels an active stream`, async () => {
      const partial = events.slice(0, provider === "anthropic" ? 3 : 1);
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(partial.map(event => `${provider === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("")));
        } }), { headers: { "content-type": "text/event-stream" } });
      } });
      try {
        const controller = new AbortController();
        const adapter = createProvider({ provider, model: "test-model", apiKey: "fixture-key", baseURL: server.url.origin });
        let text = false;
        await expect((async () => {
          for await (const event of adapter.stream(request, controller.signal)) {
            if (event.type === "text") { text = true; controller.abort(); }
          }
        })()).rejects.toThrow("cancelled");
        expect(text).toBe(true);
      } finally { server.stop(true); }
    }, 3000);
  }
});
