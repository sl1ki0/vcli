import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  balanced,
  type ArchitectureGraph,
  type ArchitectureService,
  type Session,
} from "@vcli/core";
import { Workspace } from "../src/workspace.tsx";
import {
  WorkspaceSettingsError,
  type WorkspaceOptions,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdate,
} from "../src/contracts.ts";

const emptyGraph: ArchitectureGraph = {
  root: "/sample",
  revision: "empty",
  nodes: [],
  edges: [],
  diagnostics: [],
  cycles: [],
  stats: { files: 0, parsed: 0, cached: 0, durationMs: 0 },
};
const sourceGraph: ArchitectureGraph = {
  ...emptyGraph,
  revision: "source",
  nodes: [{ id: "module:app.ts", label: "app.ts", path: "app.ts", kind: "module" }],
};
const architecture: ArchitectureService = {
  scan: async () => emptyGraph,
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  writeDesign: async () => {},
  intendedGraph: () => emptyGraph,
  check: () => [],
};
const missingSettings: WorkspaceSettings = {
  provider: "openai",
  model: "",
  credential: "missing",
  permission: "yolo",
  contextWindow: 32_768,
  context: { ...balanced },
};
type Setup = Awaited<ReturnType<typeof testRender>>;
const fixtureSession: Session = {
  id: "fixture",
  root: "/sample",
  provider: "fixture",
  model: "fixture",
  status: "complete",
  createdAt: "now",
  updatedAt: "now",
  messages: [],
  ledger: {
    goal: "fixture",
    constraints: [],
    decisions: [],
    pending: [],
    touchedPaths: [],
    verification: [],
  },
  usage: { input: 0, output: 0, cached: 0 },
};

async function renderWorkspace(overrides: Partial<WorkspaceOptions> = {}) {
  return testRender(
    () => (
      <Workspace
        root="/sample"
        graph={emptyGraph}
        architecture={architecture}
        permission="yolo"
        renderer="off"
        settings={missingSettings}
        {...overrides}
      />
    ),
    { width: 120, height: 36, kittyKeyboard: true },
  );
}
async function command(setup: Setup, text: string) {
  setup.mockInput.pressEscape();
  await setup.flush();
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await setup.flush();
}
async function replaceInput(setup: Setup, text: string) {
  setup.mockInput.pressKey("e", { ctrl: true });
  setup.mockInput.pressKey("u", { ctrl: true });
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await setup.flush();
}

describe("first-run local setup", () => {
  test("reconnect preserves custom endpoints, rejects invalid URLs, and accepts retained credentials after provider switching", async () => {
    const updates: WorkspaceSettingsUpdate[] = [];
    const setup = await renderWorkspace({
      settings: {
        ...missingSettings,
        model: "existing-model",
        baseURL: "https://custom.example/v1",
        credential: "environment",
      },
      configure: async (update) => {
        updates.push(update);
        if (update.kind !== "connection") throw new Error("Expected a connection");
        return {
          ...missingSettings,
          provider: update.provider,
          model: update.model,
          baseURL: update.baseURL,
          credential: "environment",
        };
      },
    });
    try {
      await command(setup, "/connect");
      setup.mockInput.pressKey("1");
      await setup.flush();
      await replaceInput(setup, "changed-model");
      expect(setup.captureCharFrame()).toContain("Endpoint URL");
      await replaceInput(setup, "https://custom.example/v1?api_key=invalid");
      expect(setup.captureCharFrame()).toContain("without credentials, query, or fragment");
      expect(updates).toHaveLength(0);
      await replaceInput(setup, "https://custom.example/v1/");
      setup.mockInput.pressEnter(); // Use an existing scoped/environment key.
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Key storage");
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Connection saved"));
      expect(updates[0]).toMatchObject({
        provider: "openai",
        baseURL: "https://custom.example/v1",
        apiKey: undefined,
      });
      await command(setup, "/connect");
      setup.mockInput.pressKey("2");
      await setup.flush();
      await replaceInput(setup, "anthropic-model");
      expect(setup.captureCharFrame()).toContain("API key");
      setup.mockInput.pressEnter();
      await setup.flush();
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Connection saved"));
      expect(updates[1]).toMatchObject({
        provider: "anthropic",
        baseURL: undefined,
        apiKey: undefined,
      });
    } finally {
      setup.renderer.destroy();
    }
  });

  test("safe validation failures return to the field that needs repair", async () => {
    let attempts = 0;
    const setup = await renderWorkspace({
      configure: async () => {
        attempts++;
        throw new WorkspaceSettingsError("endpoint", "Endpoint needs correction");
      },
    });
    try {
      await command(setup, "/connect");
      setup.mockInput.pressKey("4");
      await setup.flush();
      await replaceInput(setup, "fixture-model");
      await replaceInput(setup, "http://localhost:1234/v1");
      await setup.mockInput.typeText("secret-that-must-be-cleared");
      setup.mockInput.pressEnter();
      await setup.flush();
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Endpoint needs correction"));
      expect(setup.captureCharFrame()).toContain("Endpoint URL");
      expect(setup.captureCharFrame()).not.toContain("secret-that-must-be-cleared");
      expect(attempts).toBe(1);
      await replaceInput(setup, "http://localhost:1235/v1");
      expect(setup.captureCharFrame()).toContain("waiting for key");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("empty projects show a useful welcome and help; Escape still permits exploration", async () => {
    let calls = 0;
    const setup = await renderWorkspace({
      run: async () => {
        calls++;
        return fixtureSession;
      },
    });
    try {
      await setup.flush();
      const welcome = setup.captureCharFrame();
      expect(welcome).toContain("Welcome to vcli");
      expect(welcome).toContain("No source files");
      expect(welcome).toContain("1. Open project");
      expect(welcome).toContain("F1 Help");
      setup.mockInput.pressEscape();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("No source files in this folder");
      setup.mockInput.pressKey("F1");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Help / commands");
      expect(setup.captureCharFrame()).toContain("/connect");
      expect(setup.captureCharFrame()).toContain("/tokens");
      await command(setup, "Please change the code");
      expect(setup.captureCharFrame()).toContain("Connect provider");
      expect(calls).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test.each([false, true])(
    "connection setup masks typed/pasted keys and records explicit storage save=%s",
    async (saveKey) => {
      const updates: WorkspaceSettingsUpdate[] = [];
      let inference = 0;
      const frames: string[] = [];
      const setup = await renderWorkspace({
        configure: async (update) => {
          updates.push(update);
          if (update.kind !== "connection") throw new Error("Unexpected settings update");
          return {
            ...missingSettings,
            provider: update.provider,
            model: update.model,
            baseURL: update.baseURL,
            credential: update.saveKey ? "saved" : "session",
          };
        },
        run: async () => {
          inference++;
          return fixtureSession;
        },
      });
      const capture = () => frames.push(setup.captureCharFrame());
      setup.renderer.on("frame", capture);
      try {
        await command(setup, "/connect");
        setup.mockInput.pressKey("4");
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Model ID");
        await replaceInput(setup, "fixture-model");
        expect(setup.captureCharFrame()).toContain("Endpoint URL");
        await replaceInput(setup, "http://127.0.0.1:4242/v1");
        expect(setup.captureCharFrame()).toContain("API key");
        expect(setup.renderer.root.findDescendantById("setup-field")).toBeUndefined();
        expect(setup.renderer.root.findDescendantById("task-input")).toBeUndefined();
        await setup.mockInput.typeText("sk-");
        await setup.mockInput.pasteBracketedText("hidden-fixture");
        setup.mockInput.pressBackspace();
        await setup.mockInput.typeText("X");
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("•••");
        setup.mockInput.pressEnter();
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Key storage");
        expect(setup.captureCharFrame()).toContain("Session only (default)");
        expect(setup.captureCharFrame()).toContain("unencrypted");
        if (saveKey) setup.mockInput.pressKey("2");
        else setup.mockInput.pressEnter();
        await setup.waitForFrame((frame) => frame.includes("Connection saved"));
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
          kind: "connection",
          provider: "compatible",
          model: "fixture-model",
          baseURL: "http://127.0.0.1:4242/v1",
          apiKey: "sk-hidden-fixturX",
          saveKey,
        });
        expect(frames.join("\n")).not.toContain("sk-");
        expect(frames.join("\n")).not.toContain("hidden-fixture");
        expect(inference).toBe(0);
      } finally {
        setup.renderer.off("frame", capture);
        setup.renderer.destroy();
      }
    },
  );

  test("cancelling key entry clears the private value; backend errors cannot echo a key", async () => {
    let updates = 0;
    const setup = await renderWorkspace({
      configure: async (update) => {
        updates++;
        throw new Error(`Backend echo ${update.kind === "connection" ? update.apiKey : ""}`);
      },
    });
    try {
      await command(setup, "/connect");
      setup.mockInput.pressKey("1");
      await setup.flush();
      await replaceInput(setup, "fixture-model");
      await setup.mockInput.typeText("discard-this-key");
      setup.mockInput.pressEscape();
      await setup.flush();
      await command(setup, "/connect");
      setup.mockInput.pressKey("1");
      await setup.flush();
      await replaceInput(setup, "fixture-model");
      expect(setup.captureCharFrame()).toContain("waiting for key");
      setup.mockInput.pressEnter();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Key storage");
      expect(updates).toBe(0);
      await command(setup, "/connect");
      setup.mockInput.pressKey("1");
      await setup.flush();
      await replaceInput(setup, "fixture-model");
      await setup.mockInput.pasteBracketedText("backend-secret-fixture");
      setup.mockInput.pressEnter();
      await setup.flush();
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Connection could not be saved"));
      expect(setup.captureCharFrame()).not.toContain("backend-secret-fixture");
      expect(updates).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("budget edits stage locally, cancel cleanly and commit optional total limits", async () => {
    const updates: WorkspaceSettingsUpdate[] = [];
    const configured = {
      ...missingSettings,
      model: "fixture-model",
      credential: "environment" as const,
      context: { ...balanced, taskTokens: 64_000 },
    };
    const setup = await renderWorkspace({
      settings: configured,
      configure: async (update) => {
        updates.push(update);
        return update.kind === "budgets"
          ? { ...configured, contextWindow: update.contextWindow, context: update.context }
          : configured;
      },
    });
    try {
      await command(setup, "/tokens");
      setup.mockInput.pressKey("2");
      await setup.flush();
      await replaceInput(setup, "12000");
      expect(setup.captureCharFrame()).toContain("Prompt budget: 12,000");
      setup.mockInput.pressEscape();
      await setup.flush();
      expect(updates).toHaveLength(0);
      await command(setup, "/tokens");
      expect(setup.captureCharFrame()).toContain("Prompt budget: 32,000");
      setup.mockInput.pressKey("2");
      await setup.flush();
      await replaceInput(setup, "12288");
      setup.mockInput.pressKey("8");
      await setup.flush();
      await replaceInput(setup, "off");
      setup.mockInput.pressKey("9");
      await setup.waitForFrame((frame) => frame.includes("Token budgets saved"));
      expect(updates).toHaveLength(1);
      const update = updates[0];
      expect(update?.kind).toBe("budgets");
      if (update?.kind === "budgets") {
        expect(update.context.promptTokens).toBe(12_288);
        expect(Object.hasOwn(update.context, "taskTokens")).toBe(false);
      }
    } finally {
      setup.renderer.destroy();
    }
  });

  test("slash commands stay local and project switching closes only after success", async () => {
    let inference = 0;
    const topics: string[] = [];
    const projects: string[] = [];
    const setup = await renderWorkspace({
      graph: sourceGraph,
      settings: { ...missingSettings, model: "fixture-model", credential: "environment" },
      inspect: async (topic) => {
        topics.push(topic);
        return `Local ${topic} records`;
      },
      openProject: async (path) => {
        projects.push(path);
        throw new Error("Folder not found");
      },
      run: async () => {
        inference++;
        return fixtureSession;
      },
    });
    try {
      for (const text of [
        "/help",
        "/commands",
        "/status",
        "/sessions",
        "/plugins",
        "/skills",
        "/observed",
        "/intended",
        "/changes",
        "/scan",
        "/not-a-command",
      ])
        await command(setup, text);
      expect(topics).toEqual(["sessions", "plugins", "skills"]);
      expect(inference).toBe(0);
      await command(setup, "/open /missing/project");
      await setup.waitForFrame((frame) => frame.includes("Folder not found"));
      expect(projects).toEqual(["/missing/project"]);
      expect(setup.captureCharFrame()).toContain("Open project");
      expect(inference).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });
});
