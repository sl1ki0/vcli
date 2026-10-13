import { describe, expect, test } from "bun:test";
import type { ModelEvent, ModelRequest, ProviderAdapter, ReasoningEffort } from "@vcli/core";
import {
  createProvider,
  OPENROUTER_BASE_URL,
  type ProviderConfig,
  type WireObject,
} from "../src/index.ts";

const request: ModelRequest = {
  system: "Inspect modules.",
  messages: [{ role: "user", text: "Plan the module." }],
  tools: [],
  maxOutputTokens: 4096,
};
async function collect(provider: ProviderAdapter, input = request) {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(input, new AbortController().signal))
    events.push(event);
  return events;
}
function completion(provider: ProviderConfig["provider"]): WireObject[] {
  if (provider === "openai") return [{ type: "response.completed", response: { output: [] } }];
  if (provider === "anthropic")
    return [
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
  if (provider === "gemini")
    return [{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }];
  return [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
}
function fake(config: ProviderConfig, chunks = completion(config.provider)) {
  const inputs: WireObject[] = [];
  const provider = createProvider(config, {
    transport: async (input) => {
      inputs.push(input);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  });
  return { provider, inputs };
}

describe("native reasoning controls", () => {
  test("default omits all effort, thinking and summary tuning fields", async () => {
    for (const provider of ["openai", "anthropic", "gemini", "openrouter", "compatible"] as const) {
      const f = fake({ provider, model: "test-model", reasoning: "default" });
      await collect(f.provider);
      for (const name of ["reasoning", "reasoning_effort", "thinking", "output_config"])
        expect(f.inputs[0]![name]).toBeUndefined();
      expect((f.inputs[0]!.config as WireObject | undefined)?.thinkingConfig).toBeUndefined();
    }
  });

  test("maps selected effort to native fields while retaining the chosen model", async () => {
    const cases: [ProviderConfig, WireObject][] = [
      [
        { provider: "openai", model: "gpt-6.1-sol", reasoning: "medium" },
        { reasoning: { effort: "medium", summary: "auto" } },
      ],
      [
        { provider: "anthropic", model: "claude-opus-4-6", reasoning: "high" },
        {
          output_config: { effort: "high" },
          thinking: { type: "adaptive", display: "summarized" },
        },
      ],
      [
        { provider: "anthropic", model: "claude-opus-4-6", reasoning: "none" },
        { thinking: { type: "disabled" } },
      ],
      [
        { provider: "gemini", model: "gemini-3-flash-preview", reasoning: "minimal" },
        { config: { thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: true } } },
      ],
      [
        { provider: "gemini", model: "gemini-2.5-flash", reasoning: "none" },
        { config: { thinkingConfig: { thinkingBudget: 0 } } },
      ],
      [
        { provider: "openrouter", model: "vendor/test", reasoning: "low" },
        { reasoning: { effort: "low" }, provider: { require_parameters: true } },
      ],
      [
        { provider: "compatible", model: "custom-model", reasoning: "high" },
        { reasoning_effort: "high" },
      ],
    ];
    for (const [config, expected] of cases) {
      const f = fake(config);
      await collect(f.provider);
      expect(f.inputs[0]).toMatchObject({ ...expected, model: config.model });
    }
  });

  test("rejects unsupported efforts before calling a transport", () => {
    const cases: [ProviderConfig["provider"], string, ReasoningEffort][] = [
      ["openai", "gpt-6-astra", "none"],
      ["openai", "gpt-6.1-sol", "minimal"],
      ["anthropic", "claude-opus-4-6", "minimal"],
      ["anthropic", "claude-opus-4-6", "xhigh"],
      ["gemini", "gemini-3-pro-preview", "medium"],
      ["gemini", "gemini-3.1-pro-preview", "minimal"],
      ["gemini", "gemini-2.5-pro", "none"],
      ["gemini", "gemini-2.5-flash", "high"],
      ["openrouter", "google/gemini-3-pro-preview", "xhigh"],
    ];
    for (const [provider, model, reasoning] of cases)
      expect(() => createProvider({ provider, model, reasoning })).toThrow("unsupported");
    expect(() =>
      createProvider({
        provider: "openai",
        model: "custom",
        reasoning: "invalid" as ReasoningEffort,
      }),
    ).toThrow("Unknown reasoning effort");
  });

  test("sanitizes model-dependent HTTP400 errors with actionable effort guidance", async () => {
    const provider = createProvider(
      { provider: "openai", model: "custom", reasoning: "max" },
      {
        transport: async () => {
          throw Object.assign(new Error("secret-key-body"), { status: 400 });
        },
      },
    );
    await expect(collect(provider)).rejects.toThrow('reasoning effort "max"');
    await expect(collect(provider)).rejects.not.toThrow("secret-key-body");
  });
});

describe("provider-exposed reasoning streams", () => {
  test("OpenAI summaries remain separate from answer text and encrypted continuation", async () => {
    const output = [
      {
        type: "reasoning",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "Inspect edges." }],
      },
    ];
    const f = fake({ provider: "openai", model: "gpt-6.1-sol", reasoning: "low" }, [
      { type: "response.reasoning_summary_text.delta", delta: "Inspect edges." },
      { type: "response.output_text.delta", delta: "Use two modules." },
      { type: "response.completed", response: { output } },
    ]);
    const events = await collect(f.provider);
    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning", text: "Inspect edges." },
      { type: "text", text: "Use two modules." },
    ]);
    expect(events.at(-1)).toMatchObject({ providerData: { output } });
  });

  test("Anthropic thinking and Gemini thoughts preserve signatures outside display events", async () => {
    const anthropic = fake({ provider: "anthropic", model: "claude-opus-4-6", reasoning: "low" }, [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "Plan ", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "modules." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed-thinking" },
      },
      ...completion("anthropic"),
    ]);
    const events = await collect(anthropic.provider);
    expect(events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Plan " },
      { type: "reasoning", text: "modules." },
    ]);
    expect(events.at(-1)).toMatchObject({
      providerData: {
        content: [{ type: "thinking", thinking: "Plan modules.", signature: "signed-thinking" }],
      },
    });
    const part = { text: "Inspect imports.", thought: true, thoughtSignature: "signed-gemini" };
    const gemini = fake({ provider: "gemini", model: "gemini-3-flash-preview", reasoning: "low" }, [
      {
        candidates: [
          { content: { parts: [part, { text: "Split storage." }] }, finishReason: "STOP" },
        ],
      },
    ]);
    const result = await collect(gemini.provider);
    expect(result.slice(0, 2)).toEqual([
      { type: "reasoning", text: "Inspect imports." },
      { type: "text", text: "Split storage." },
    ]);
    expect(result.at(-1)).toMatchObject({
      providerData: { parts: [part, { text: "Split storage." }] },
    });
  });

  test("OpenRouter replays the full reasoning sequence with tool results without displaying encrypted data", async () => {
    const details = [
      { index: 0, id: "r1", type: "reasoning.text", text: "Inspect ", signature: null },
      { index: 0, id: "r1", type: "reasoning.text", text: "modules.", signature: "signed" },
      { index: 1, id: "r2", type: "reasoning.encrypted", data: "opaque-encrypted" },
    ];
    const f = fake({ provider: "openrouter", model: "vendor/test" }, [
      {
        choices: [{ index: 0, delta: { reasoning: "Inspect ", reasoning_details: [details[0]] } }],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: details.slice(1),
              tool_calls: [
                { index: 0, id: "call1", function: { name: "inspect", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const events = await collect(f.provider);
    expect(events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Inspect " },
      { type: "reasoning", text: "modules." },
    ]);
    const done = events.at(-1)!;
    await collect(f.provider, {
      ...request,
      messages: [
        request.messages[0]!,
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "call1", name: "inspect", arguments: {} }],
          providerData: done.type === "done" ? done.providerData : undefined,
        },
        { role: "tool", text: "done", toolCallId: "call1" },
      ],
    });
    const messages = f.inputs[1]!.messages as WireObject[];
    expect(messages[2]).toMatchObject({
      role: "assistant",
      reasoning_details: details,
      tool_calls: [{ id: "call1" }],
    });
    expect(messages[3]).toEqual({ role: "tool", content: "done", tool_call_id: "call1" });
  });

  test("compatible reasoning_content stays in its original continuation field", async () => {
    const f = fake({ provider: "compatible", model: "local-reasoner" }, [
      { choices: [{ index: 0, delta: { reasoning_content: "Check " } }] },
      {
        choices: [{ index: 0, delta: { reasoning_content: "imports." }, finish_reason: "stop" }],
      },
    ]);
    const events = await collect(f.provider);
    expect(events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Check " },
      { type: "reasoning", text: "imports." },
    ]);
    const done = events.at(-1)!;
    await collect(f.provider, {
      ...request,
      messages: [
        {
          role: "assistant",
          text: "",
          providerData: done.type === "done" ? done.providerData : undefined,
        },
      ],
    });
    const message = (f.inputs[1]!.messages as WireObject[])[1]!;
    expect(message.reasoning_content).toBe("Check imports.");
    expect(message.reasoning).toBeUndefined();
  });

  test("OpenRouter imports without credentials and never falls back to an OpenAI key", async () => {
    const priorRouter = process.env.OPENROUTER_API_KEY;
    const priorOpenAI = process.env.OPENAI_API_KEY;
    let requests = 0;
    try {
      delete process.env.OPENROUTER_API_KEY;
      process.env.OPENAI_API_KEY = "unrelated-fixture-key";
      const provider = createProvider(
        { provider: "openrouter", model: "vendor/test" },
        {
          fetch: (async (_input, _init) => {
            requests++;
            return new Response("Unexpected fixture request", { status: 401 });
          }) as typeof fetch,
        },
      );
      await expect(collect(provider)).rejects.toThrow("OPENROUTER_API_KEY");
      expect(requests).toBe(0);
    } finally {
      if (priorRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = priorRouter;
      if (priorOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenAI;
    }
  });

  test("official SDK targets OpenRouter's default endpoint with its own key and reasoning body", async () => {
    let url = "",
      authorization = "";
    let body: WireObject = {};
    const provider = createProvider(
      { provider: "openrouter", model: "vendor/test", apiKey: "fixture-key", reasoning: "medium" },
      {
        fetch: (async (input, init) => {
          url = String(input);
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          body = JSON.parse(String(init?.body));
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"reasoning":"Check."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      },
    );
    const events = await collect(provider);
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(authorization).toBe("Bearer fixture-key");
    expect(body).toMatchObject({ model: "vendor/test", reasoning: { effort: "medium" } });
    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning", text: "Check." },
      { type: "text", text: "Ready." },
    ]);
  });
});
