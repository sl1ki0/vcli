import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import { balanced } from "@vcli/core";
import { loadConfig } from "../apps/cli/src/config.ts";
import { createHarness } from "../apps/cli/src/harness.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

interface FixtureRequest {
  messages: { role: string; content?: unknown }[];
}

test("strict architecture scans keep denied source out of parent and explorer model contexts", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-architecture-policy-")));
  fixtures.push(directory);
  const root = join(directory, "project");
  const stateDirectory = join(directory, "state");
  const policyPath = join(directory, "policy.json");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "private"));
  await writeFile(join(root, "src/public.ts"), "export const publicValue = 'allowed module';\n");
  const marker = "synthetic-denied-architecture-secret";
  await writeFile(join(root, "private/secret.ts"), `export type PrivateValue = '${marker}';\n`);
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      commands: { allow: [], deny: [] },
      directories: { allow: ["."], deny: ["private"] },
    }),
  );
  const architecture = createArchitectureService();
  // A prior unrestricted scan must not poison a subsequent policy-scoped scan through its cache.
  await architecture.scan(root);
  expect(await readFile(join(root, ".vcli/state/architecture-index.json"), "utf8")).toContain(
    marker,
  );
  const requests: FixtureRequest[] = [];
  let parentTurns = 0;
  let childTurns = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as FixtureRequest;
      requests.push(body);
      const child = body.messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("Delegated task:"),
      );
      const turn = child ? childTurns++ : parentTurns++;
      const call = child
        ? turn === 0
          ? { name: "architecture_query", args: {} }
          : undefined
        : [
            { name: "architecture_query", args: {} },
            { name: "tools_search", args: { query: "subagent_explore" } },
            {
              name: "subagent_explore",
              args: { prompt: "Inspect allowed architecture", tokens: 4000 },
            },
          ][turn];
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `${child ? "child" : "parent"}-${turn}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }
        : { content: child ? "Explorer finished." : "Parent finished." };
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const priorHome = process.env.VCLI_CONFIG_HOME;
  process.env.VCLI_CONFIG_HOME = join(directory, "isolated-home");
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const config = await loadConfig(root, {
      provider: "compatible",
      model: "fixture-model",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      permission: "yolo",
      renderer: "off",
      contextWindow: 32_768,
      context: { ...balanced, outputTokens: 512, mapTokens: 2000, maxTurns: 8 },
    });
    harness = await createHarness(root, config, architecture, undefined, undefined, {
      apiKey: "fixture-key",
      policyPath,
      stateDirectory,
    });
    const session = await harness.run(
      "Inspect architecture and delegate a read-only check.",
      new AbortController().signal,
    );
    expect(session.status).toBe("complete");
    expect(parentTurns).toBe(4);
    expect(childTurns).toBe(2);
    expect(JSON.stringify(requests)).toContain("src/public.ts");
    expect(JSON.stringify(requests)).not.toContain(marker);
    expect(JSON.stringify(requests)).not.toContain("private/secret.ts");
    const query = session.runState!.calls["parent-0"]!.result!;
    expect(query.isError).not.toBe(true);
    expect(JSON.stringify(query)).toContain("src/public.ts");
    expect(JSON.stringify(query)).not.toContain(marker);
    expect(JSON.stringify(query)).not.toContain("private/secret.ts");
    for (const saved of await harness.store.list(root)) {
      expect(JSON.stringify(saved.messages)).not.toContain(marker);
      expect(JSON.stringify(saved.messages)).not.toContain("private/secret.ts");
    }
  } finally {
    await harness?.close();
    server.stop(true);
    if (priorHome === undefined) delete process.env.VCLI_CONFIG_HOME;
    else process.env.VCLI_CONFIG_HOME = priorHome;
    await rm(directory, { recursive: true, force: true });
  }
});
