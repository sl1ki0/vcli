import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureService } from "@vcli/architecture";
import { balanced } from "@vcli/core";
import { loadConfig, patchConfig } from "../apps/cli/src/config.ts";
import { credentialScope, resolveCredential, saveCredential } from "../apps/cli/src/credentials.ts";
import { createHarness } from "../apps/cli/src/harness.ts";
import { createWorkspaceSettings } from "../apps/cli/src/workspace-settings.ts";

const environmentNames = [
  "VCLI_CONFIG_HOME",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "VCLI_COMPATIBLE_API_KEY",
];
let directory: string;
let root: string;
let home: string;
let previous: Record<string, string | undefined>;

beforeEach(async () => {
  previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  directory = await mkdtemp(join(tmpdir(), "vcli-setup-"));
  root = join(directory, "project");
  home = join(directory, "home");
  await mkdir(root);
  await mkdir(home);
  await writeFile(join(root, "index.ts"), "export const ready = true;\n");
  process.env.VCLI_CONFIG_HOME = home;
});
afterEach(async () => {
  for (const name of environmentNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  await rm(directory, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(join(root, ".vcli"), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
function fixture() {
  const authorizations: (string | null)[] = [];
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      authorizations.push(request.headers.get("authorization"));
      requests.push(await request.json());
      const chunks = [
        { choices: [{ index: 0, delta: { content: "Connection works." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, authorizations, requests };
}

describe("workspace setup backend", () => {
  test("includes OpenRouter without changing defaults or borrowing another provider's credentials", async () => {
    process.env.OPENAI_API_KEY = "openai-fixture-key";
    const config = await loadConfig(root);
    expect(config).toMatchObject({ provider: "openai", model: "", reasoning: "default" });
    const routerConfig = { ...config, provider: "openrouter" as const };
    const settings = createWorkspaceSettings(root, routerConfig);
    expect(await settings.snapshot()).toMatchObject({
      provider: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      credential: "missing",
      reasoning: "default",
    });
    process.env.OPENROUTER_API_KEY = "openrouter-fixture-key";
    expect(await resolveCredential(routerConfig)).toEqual({
      status: "environment",
      apiKey: "openrouter-fixture-key",
    });
    expect(await resolveCredential({ provider: "openai" })).toEqual({
      status: "environment",
      apiKey: "openai-fixture-key",
    });
  });

  test("rejects unsupported reasoning before changing settings or saving a connection key", async () => {
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    await settings.configure({
      kind: "connection",
      provider: "gemini",
      model: "gemini-3-pro-preview",
      apiKey: "original-session-key",
      saveKey: false,
    });
    const path = join(root, ".vcli/config.json");
    const before = await readFile(path, "utf8");
    await expect(
      settings.configure({ kind: "reasoning", reasoning: "medium" }),
    ).rejects.toMatchObject({ field: "reasoning" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await settings.snapshot()).reasoning).toBe("default");
    await settings.configure({ kind: "reasoning", reasoning: "low" });
    const valid = await readFile(path, "utf8");
    await expect(
      settings.configure({
        kind: "connection",
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: "must-not-save-key",
        saveKey: true,
      }),
    ).rejects.toMatchObject({ field: "reasoning" });
    expect(await readFile(path, "utf8")).toBe(valid);
    expect(settings.harnessOptions()).toEqual({ apiKey: "original-session-key" });
    expect(await Bun.file(join(home, "credentials.json")).exists()).toBe(false);
  });

  test("OpenRouter saved keys share the canonical default URL and isolate custom endpoints", async () => {
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    await settings.configure({
      kind: "connection",
      provider: "openrouter",
      model: "vendor/test",
      apiKey: "router-fixture-key",
      saveKey: true,
    });
    const explicit = { provider: "openrouter" as const, baseURL: "https://openrouter.ai/api/v1/" };
    expect(credentialScope(explicit)).toBe(credentialScope({ provider: "openrouter" }));
    expect(await resolveCredential(explicit)).toEqual({
      status: "saved",
      apiKey: "router-fixture-key",
    });
    expect(
      await resolveCredential({ provider: "openrouter", baseURL: "https://other.invalid/api/v1" }),
    ).toEqual({ status: "missing" });
    expect(await resolveCredential({ provider: "compatible", baseURL: explicit.baseURL })).toEqual({
      status: "not-required",
    });
    await settings.configure({
      kind: "connection",
      ...explicit,
      model: "vendor/test",
      saveKey: false,
    });
    expect(settings.harnessOptions()).toEqual({ apiKey: "router-fixture-key" });
    await settings.configure({
      kind: "connection",
      provider: "openai",
      model: "chosen-model",
      saveKey: false,
    });
    expect(settings.harnessOptions()).toEqual({});
    expect(await readFile(join(root, ".vcli/config.json"), "utf8")).not.toContain(
      "router-fixture-key",
    );
  });

  test("reasoning persists across settings snapshots, reloads and a real OpenRouter SDK request", async () => {
    await put(join(root, ".vcli/config.json"), {
      projectLabel: "Keep label",
      context: { mapTokens: 1200 },
    });
    const f = fixture();
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    try {
      await settings.configure({
        kind: "connection",
        provider: "openrouter",
        model: "vendor/test",
        baseURL: f.server.url.origin + "/api/v1",
        apiKey: "router-session-key",
        saveKey: false,
      });
      expect(await settings.configure({ kind: "reasoning", reasoning: "high" })).toMatchObject({
        provider: "openrouter",
        reasoning: "high",
      });
      const reloaded = await loadConfig(root);
      expect(reloaded.reasoning).toBe("high");
      expect(JSON.parse(await readFile(join(root, ".vcli/config.json"), "utf8"))).toMatchObject({
        projectLabel: "Keep label",
        context: { mapTokens: 1200 },
        reasoning: "high",
      });
      const harness = await createHarness(
        root,
        reloaded,
        createArchitectureService(),
        undefined,
        undefined,
        settings.harnessOptions(),
      );
      try {
        expect((await harness.run("Reply ready.", new AbortController().signal)).status).toBe(
          "complete",
        );
      } finally {
        await harness.close();
      }
      expect(f.authorizations).toEqual(["Bearer router-session-key"]);
      expect(f.requests[0]).toMatchObject({ model: "vendor/test", reasoning: { effort: "high" } });
    } finally {
      f.server.stop(true);
    }
  });

  test("explicit local save persists a retained session key and blank provider switches resolve environment keys", async () => {
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    const target = { provider: "openai" as const, model: "fixture-model", saveKey: false };
    await settings.configure({ kind: "connection", ...target, apiKey: "retained-session-key" });
    expect(await Bun.file(join(home, "credentials.json")).exists()).toBe(false);
    const saved = await settings.configure({ kind: "connection", ...target, saveKey: true });
    expect(saved.credential).toBe("saved");
    expect((await resolveCredential({ provider: "openai" })).apiKey).toBe("retained-session-key");
    process.env.ANTHROPIC_API_KEY = "existing-environment-key";
    const switched = await settings.configure({
      kind: "connection",
      provider: "anthropic",
      model: "different-model",
      saveKey: false,
    });
    expect(switched.credential).toBe("environment");
    expect(settings.harnessOptions()).toEqual({});
    expect(await readFile(join(root, ".vcli/config.json"), "utf8")).not.toContain(
      "retained-session-key",
    );
  });

  test("writes project defaults while preserving unrelated project and user fields", async () => {
    const user = { renderer: "off", context: { mapTokens: 1200 }, editor: { theme: "custom" } };
    await put(join(home, "config.json"), user);
    await put(join(root, ".vcli/config.json"), {
      projectLabel: "Keep me",
      mcpServers: [{ name: "local", type: "stdio", command: "unused" }],
      context: { taskTokens: 20_000 },
    });
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    expect((await settings.snapshot()).credential).toBe("missing");
    await settings.configure({
      kind: "connection",
      provider: "compatible",
      model: "local-model",
      baseURL: "http://localhost:1234/v1/",
      saveKey: false,
    });
    await settings.configure({ kind: "permission", permission: "read-only" });
    const updated = await settings.configure({
      kind: "budgets",
      contextWindow: 32_768,
      context: { ...balanced, mapTokens: 1300, outputTokens: 1024 },
    });
    expect(updated).toMatchObject({
      credential: "not-required",
      provider: "compatible",
      model: "local-model",
      permission: "read-only",
      baseURL: "http://localhost:1234/v1",
    });
    const persisted = JSON.parse(await readFile(join(root, ".vcli/config.json"), "utf8"));
    expect(persisted.projectLabel).toBe("Keep me");
    expect(persisted.mcpServers).toHaveLength(1);
    expect(persisted.context.taskTokens).toBeNull();
    expect((await loadConfig(root)).context.taskTokens).toBeUndefined();
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual(user);
    expect((await loadConfig(root)).permission).toBe("read-only");
    expect(settings.currentConfig().renderer).toBe("off");
    const copy = settings.currentConfig();
    copy.model = "Changed outside";
    expect(settings.currentConfig().model).toBe("local-model");
  });

  test("saved credentials use private modes and reach an ordinary headless SDK request", async () => {
    const model = fixture();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const settings = createWorkspaceSettings(root, await loadConfig(root));
      const snapshot = await settings.configure({
        kind: "connection",
        provider: "compatible",
        model: "fixture-model",
        baseURL: model.server.url.origin,
        apiKey: "fixture-saved-key",
        saveKey: true,
      });
      expect(snapshot.credential).toBe("saved");
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, "credentials.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, ".vcli/config.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, ".vcli/config.json"), "utf8")).not.toContain(
        "fixture-saved-key",
      );
      expect(JSON.stringify(snapshot)).not.toContain("fixture-saved-key");
      const restarted = createWorkspaceSettings(root, await loadConfig(root));
      expect((await restarted.snapshot()).credential).toBe("saved");
      expect(restarted.harnessOptions()).toEqual({});
      harness = await createHarness(root, await loadConfig(root), createArchitectureService());
      const session = await harness.run("Check connection.", new AbortController().signal);
      expect(session.status).toBe("complete");
      expect(model.authorizations).toEqual(["Bearer fixture-saved-key"]);
      expect(JSON.stringify(session)).not.toContain("fixture-saved-key");
      expect(JSON.stringify(model.requests)).not.toContain("fixture-saved-key");
    } finally {
      await harness?.close();
      model.server.stop(true);
    }
  });

  test("session keys override environment and saved keys without being written to disk", async () => {
    const model = fixture();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const target = { provider: "compatible" as const, baseURL: model.server.url.origin };
      await saveCredential(target, "fixture-old-saved-key");
      process.env.VCLI_COMPATIBLE_API_KEY = "fixture-environment-key";
      const settings = createWorkspaceSettings(root, await loadConfig(root));
      await settings.configure({
        kind: "connection",
        ...target,
        model: "fixture-model",
        apiKey: "fixture-session-key",
        saveKey: false,
      });
      expect((await settings.snapshot()).credential).toBe("session");
      expect(process.env.VCLI_COMPATIBLE_API_KEY).toBe("fixture-environment-key");
      expect(await readFile(join(home, "credentials.json"), "utf8")).not.toContain(
        "fixture-session-key",
      );
      expect(JSON.stringify(settings.currentConfig())).not.toContain("fixture-session-key");
      harness = await createHarness(
        root,
        settings.currentConfig(),
        createArchitectureService(),
        undefined,
        undefined,
        settings.harnessOptions(),
      );
      expect(
        (await harness.run("Check transient connection.", new AbortController().signal)).status,
      ).toBe("complete");
      expect(model.authorizations).toEqual(["Bearer fixture-session-key"]);
      expect((await resolveCredential(target)).status).toBe("environment");
      delete process.env.VCLI_COMPATIBLE_API_KEY;
      expect((await resolveCredential(target)).apiKey).toBe("fixture-old-saved-key");
    } finally {
      await harness?.close();
      model.server.stop(true);
    }
  });

  test("blank keys retain matching credentials and endpoint changes do not reuse another saved key", async () => {
    const first = { provider: "compatible" as const, baseURL: "http://localhost:9000/v1/" };
    await saveCredential(first, "fixture-first-endpoint-key");
    await saveCredential({ provider: "openai" }, "fixture-openai-key");
    await put(join(home, "config.json"), { ...first, model: "old-model" });
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    await settings.configure({
      kind: "connection",
      ...first,
      model: "new-model",
      apiKey: "",
      saveKey: false,
    });
    expect((await settings.snapshot()).credential).toBe("saved");
    expect(settings.harnessOptions()).toEqual({});
    await settings.configure({
      kind: "connection",
      provider: "compatible",
      model: "new-model",
      baseURL: "http://localhost:9001/v1",
      apiKey: "",
      saveKey: false,
    });
    expect((await settings.snapshot()).credential).toBe("not-required");
    expect(await resolveCredential(settings.currentConfig())).not.toHaveProperty("apiKey");
    await settings.configure({
      kind: "connection",
      provider: "openai",
      model: "openai-model",
      saveKey: false,
    });
    expect(settings.currentConfig().baseURL).toBeUndefined();
    expect((await loadConfig(root)).baseURL).toBeUndefined();
    expect((await settings.snapshot()).credential).toBe("saved");
    await settings.configure({
      kind: "connection",
      provider: "gemini",
      model: "gemini-model",
      saveKey: false,
    });
    expect((await settings.snapshot()).credential).toBe("missing");
    expect(credentialScope(first)).toBe(
      credentialScope({ ...first, baseURL: "http://LOCALHOST:9000/v1" }),
    );
  });

  test("initial transient options survive a same-scope project change and stay isolated on new connections", async () => {
    const config = await loadConfig(root, {
      provider: "compatible",
      model: "local",
      baseURL: "http://localhost:8000/v1",
    });
    const initial = createWorkspaceSettings(root, config, { apiKey: "fixture-launch-key" });
    const nextRoot = join(directory, "next-project");
    await mkdir(nextRoot);
    const opened = createWorkspaceSettings(nextRoot, config, initial.harnessOptions());
    expect((await opened.snapshot()).credential).toBe("session");
    await opened.configure({
      kind: "connection",
      provider: "compatible",
      model: "local",
      baseURL: "http://localhost:8001/v1",
      saveKey: false,
    });
    expect(opened.harnessOptions()).toEqual({});
    expect((await opened.snapshot()).credential).toBe("not-required");
    expect(await Bun.file(join(home, "credentials.json")).exists()).toBe(false);
  });

  test("invalid settings batches never partially write config or credentials", async () => {
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    await settings.configure({ kind: "permission", permission: "ask" });
    const path = join(root, ".vcli/config.json");
    const before = await readFile(path, "utf8");
    await expect(
      settings.configure({
        kind: "connection",
        provider: "openai",
        model: "   ",
        apiKey: "fixture-unwritten-key",
        saveKey: true,
      }),
    ).rejects.toThrow("model name");
    await expect(
      settings.configure({
        kind: "connection",
        provider: "openai",
        model: "valid",
        apiKey: "fixture-invalid\nsecret-key",
        saveKey: true,
      }),
    ).rejects.toThrow("single line");
    await expect(
      settings.configure({
        kind: "budgets",
        contextWindow: 8192,
        context: { ...balanced, outputTokens: 8192 },
      }),
    ).rejects.toThrow("Reduce output tokens");
    await expect(
      settings.configure({
        kind: "budgets",
        contextWindow: 32768,
        context: { ...balanced, mapTokens: -1 },
      }),
    ).rejects.toThrow("positive integer");
    await expect(
      patchConfig(root, { provider: "gemini", context: { outputTokens: 0 } }),
    ).rejects.toThrow("positive integer");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await Bun.file(join(home, "credentials.json")).exists()).toBe(false);
    expect(settings.currentConfig().provider).toBe("openai");
    expect((await settings.snapshot()).permission).toBe("ask");
  });

  test("clearing a task budget overrides an inherited user cap across reload", async () => {
    await put(join(home, "config.json"), { context: { taskTokens: 50_000 } });
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    expect((await settings.snapshot()).context.taskTokens).toBe(50_000);
    const updated = await settings.configure({
      kind: "budgets",
      contextWindow: 32_768,
      context: { ...balanced },
    });
    expect(updated.context.taskTokens).toBeUndefined();
    expect((await loadConfig(root)).context.taskTokens).toBeUndefined();
    expect(
      JSON.parse(await readFile(join(root, ".vcli/config.json"), "utf8")).context.taskTokens,
    ).toBeNull();
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).context.taskTokens).toBe(
      50_000,
    );
  });

  test("credential persistence failure leaves project settings and controller unchanged", async () => {
    const settings = createWorkspaceSettings(root, await loadConfig(root));
    await settings.configure({ kind: "permission", permission: "ask" });
    const before = await readFile(join(root, ".vcli/config.json"), "utf8");
    await mkdir(join(home, "credentials.json"));
    await expect(
      settings.configure({
        kind: "connection",
        provider: "compatible",
        model: "new-model",
        baseURL: "http://localhost:9000/v1",
        apiKey: "fixture-unsaved-key",
        saveKey: true,
      }),
    ).rejects.toThrow("credential store");
    expect(await readFile(join(root, ".vcli/config.json"), "utf8")).toBe(before);
    expect(settings.currentConfig().provider).toBe("openai");
    expect(settings.harnessOptions()).toEqual({});
  });

  test("malformed credential/config diagnostics do not echo secret file contents", async () => {
    await writeFile(join(home, "credentials.json"), '{"secret": "fixture-secret-from-broken-json"');
    await expect(resolveCredential({ provider: "openai" })).rejects.toThrow(
      "Could not read the saved credential store",
    );
    let errorText = "";
    try {
      await resolveCredential({ provider: "openai" });
    } catch (error) {
      errorText = String(error);
    }
    expect(errorText).not.toContain("fixture-secret-from-broken-json");
    await writeFile(join(home, "config.json"), '{"apiKey": "fixture-secret-from-broken-json"');
    try {
      await loadConfig(root);
    } catch (error) {
      errorText = String(error);
    }
    expect(errorText).not.toContain("fixture-secret-from-broken-json");
    await put(join(home, "config.json"), { apiKey: "fixture-legacy-key", model: "configured" });
    expect(JSON.stringify(await loadConfig(root))).not.toContain("fixture-legacy-key");
  });
});
