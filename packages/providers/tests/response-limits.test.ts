import { expect, test } from "bun:test";
import { createProvider } from "../src/index.ts";
import { boundedProviderFetch } from "../src/shared.ts";

for (const contentType of ["application/json", "text/event-stream"]) {
  test(`provider decoded ${contentType} body stops at its byte cap without trusting Content-Length`, async () => {
    let cancelled = false,
      chunks = 0;
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (++chunks > 64) return controller.close();
            controller.enqueue(new Uint8Array(512).fill(120));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": contentType } },
      )) as unknown as typeof fetch;
    const response = await boundedProviderFetch(fetcher, 2048)("https://fixture.invalid");
    await expect(response.text()).rejects.toThrow("2048-byte transport limit");
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(64);
  });
}

for (const provider of ["openai", "compatible", "openrouter", "anthropic", "gemini"] as const) {
  test(`${provider} SDK applies the wire cap to injectable fetch and never retries an oversized response`, async () => {
    let requests = 0,
      cancelled = false;
    const adapter = createProvider(
      {
        provider,
        model: "fixture-model",
        apiKey: "fixture-key",
        ...(provider === "compatible" ? { baseURL: "http://localhost:1234/v1" } : {}),
      },
      {
        fetch: (async () => {
          requests++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "content-length": String(16 * 1024 * 1024 + 1),
              },
            },
          );
        }) as unknown as typeof fetch,
      },
    );
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
        ))
          void event;
      })(),
    ).rejects.toThrow();
    expect(requests).toBe(1);
    expect(cancelled).toBe(true);
  });
}
