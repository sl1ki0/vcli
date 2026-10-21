import { describe, expect, test } from "bun:test";
import { createProvider, DEFAULT_PROVIDER_ENDPOINTS, type ProviderConfig } from "../src/index.ts";
import { apiKey } from "../src/shared.ts";

const targets = [
  ["openai", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  ["anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  ["gemini", "GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
  ["openrouter", "OPENROUTER_API_KEY", "OPENAI_BASE_URL"],
] as const;

describe("provider credential endpoint isolation", () => {
  for (const [provider, variable, endpointVariable] of targets) {
    test(`${provider} never follows project endpoints or implicit SDK endpoint overrides with an environment key`, async () => {
      const previousKey = process.env[variable];
      const previousEndpoint = process.env[endpointVariable];
      const previousVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
      const captures: string[] = [];
      try {
        process.env[variable] = "fixture-provider-environment-key";
        process.env[endpointVariable] = "https://attacker.invalid";
        process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
        const config: ProviderConfig = { provider, model: "test-model" };
        expect(apiKey(config)).toBe("fixture-provider-environment-key");
        expect(() => apiKey({ ...config, baseURL: "https://attacker.invalid" })).toThrow(
          "explicitly for this endpoint",
        );
        expect(apiKey({ ...config, baseURL: DEFAULT_PROVIDER_ENDPOINTS[provider] + "/" })).toBe(
          "fixture-provider-environment-key",
        );
        const adapter = createProvider(config, {
          fetch: (async (input) => {
            captures.push(String(input));
            return new Response("Fixture rejection", { status: 401 });
          }) as typeof fetch,
        });
        await expect(
          (async () => {
            for await (const event of adapter.stream(
              {
                system: "Test",
                messages: [{ role: "user", text: "Test" }],
                tools: [],
                maxOutputTokens: 128,
              },
              new AbortController().signal,
            )) {
              void event;
            }
          })(),
        ).rejects.toThrow();
        expect(captures).toHaveLength(1);
        expect(captures[0]!.startsWith(DEFAULT_PROVIDER_ENDPOINTS[provider] + "/")).toBe(true);
      } finally {
        for (const [name, value] of [
          [variable, previousKey],
          [endpointVariable, previousEndpoint],
          ["GOOGLE_GENAI_USE_VERTEXAI", previousVertex],
        ]) {
          if (value === undefined) delete process.env[name!];
          else process.env[name!] = value;
        }
      }
    });
  }

  test("compatible environment keys require the same explicitly bound endpoint", () => {
    const previousKey = process.env.VCLI_COMPATIBLE_API_KEY;
    const previousEndpoint = process.env.VCLI_COMPATIBLE_BASE_URL;
    try {
      process.env.VCLI_COMPATIBLE_API_KEY = "fixture-compatible-key";
      delete process.env.VCLI_COMPATIBLE_BASE_URL;
      const config: ProviderConfig = {
        provider: "compatible",
        model: "test-model",
        baseURL: "http://localhost:8000/v1",
      };
      expect(apiKey(config)).toBe("vcli-local");
      process.env.VCLI_COMPATIBLE_BASE_URL = "http://LOCALHOST:8000/v1/";
      expect(apiKey(config)).toBe("fixture-compatible-key");
      expect(apiKey({ ...config, baseURL: "http://localhost:8001/v1" })).toBe("vcli-local");
      expect(apiKey({ ...config, baseURL: "http://localhost:8000/v1/other" })).toBe("vcli-local");
      expect(apiKey({ ...config, apiKey: "fixture-explicit-key" })).toBe("fixture-explicit-key");
      for (const baseURL of [
        "https://attacker.invalid/v1",
        "http://localhost.attacker.invalid/v1",
        "http://192.168.1.5/v1",
      ]) {
        expect(() => apiKey({ ...config, baseURL })).toThrow("explicitly for this endpoint");
      }
    } finally {
      if (previousKey === undefined) delete process.env.VCLI_COMPATIBLE_API_KEY;
      else process.env.VCLI_COMPATIBLE_API_KEY = previousKey;
      if (previousEndpoint === undefined) delete process.env.VCLI_COMPATIBLE_BASE_URL;
      else process.env.VCLI_COMPATIBLE_BASE_URL = previousEndpoint;
    }
  });
});
