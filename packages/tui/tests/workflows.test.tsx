import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { ArchitectureGraph, ArchitectureService, Session } from "@vcli/core";
import { Workspace } from "../src/workspace.tsx";

const graph: ArchitectureGraph = {
  root: "/project",
  revision: "observed",
  nodes: [{ id: "app", label: "app", kind: "module", path: "app.ts" }],
  edges: [],
  cycles: [],
  diagnostics: [],
  stats: { files: 1, parsed: 1, cached: 0, durationMs: 0 },
};
const architecture: ArchitectureService = {
  scan: async () => graph,
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  intendedGraph: () => ({ ...graph, revision: "saved", nodes: [] }),
  writeDesign: async () => {
    throw new Error("Unexpected design write");
  },
  check: () => [],
};
const session: Session = {
  id: "session",
  root: "/project",
  model: "fixture",
  provider: "fixture",
  status: "complete",
  createdAt: "now",
  updatedAt: "now",
  messages: [],
  ledger: {
    goal: "fixture",
    pending: [],
    constraints: [],
    decisions: [],
    touchedPaths: [],
    verification: [],
  },
  usage: { input: 0, output: 0, cached: 0 },
};
async function submit(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  setup.mockInput.pressEscape();
  await setup.flush();
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await setup.flush();
}

test("workflow commands are discoverable and local, with explicit plan/build transitions", async () => {
  const modes: string[] = [],
    topics: string[] = [];
  let modelCalls = 0,
    restored = "";
  const setup = await testRender(
    () => (
      <Workspace
        root="/project"
        graph={graph}
        architecture={architecture}
        renderer="off"
        permission="yolo"
        changeMode={(mode) => modes.push(mode)}
        inspect={async (topic) => {
          topics.push(topic);
          return `${topic} local records`;
        }}
        rewind={async (id) => {
          restored = id;
          return "Checkpoint restored";
        }}
        run={async () => {
          modelCalls++;
          return session;
        }}
      />
    ),
    { width: 120, height: 36, kittyKeyboard: true },
  );
  try {
    await submit(setup, "/plan");
    expect(setup.captureCharFrame()).toContain("PLAN");
    expect(modes).toEqual(["plan"]);
    for (const command of ["memory", "tasks", "checkpoints", "hooks", "plans"]) {
      await submit(setup, `/${command}`);
      expect(setup.captureCharFrame()).toContain("local records");
    }
    expect(topics).toEqual(["memory", "tasks", "checkpoints", "hooks", "plan"]);
    await submit(setup, "/build");
    expect(setup.captureCharFrame()).toContain("BUILD");
    expect(modes).toEqual(["plan", "build"]);
    await submit(setup, "/rewind checkpoint-id");
    expect(restored).toBe("checkpoint-id");
    expect(modelCalls).toBe(0);
  } finally {
    setup.renderer.destroy();
  }
});

test("a plan graph preview survives post-task refresh and explicit scanning", async () => {
  const preview: ArchitectureGraph = {
    ...graph,
    revision: "draft",
    nodes: [{ id: "draft", label: "Draft component", kind: "component" }],
  };
  const setup = await testRender(
    () => (
      <Workspace
        root="/project"
        graph={graph}
        architecture={architecture}
        renderer="off"
        permission="yolo"
        mode="plan"
        run={async (_prompt, _signal, emit) => {
          await emit({
            type: "tool-end",
            sessionId: session.id,
            time: "now",
            data: {
              name: "architecture_preview",
              result: "Draft ready",
              details: { intended: preview },
            },
          });
          return { ...session, mode: "plan" };
        }}
      />
    ),
    { width: 120, height: 36, kittyKeyboard: true },
  );
  try {
    await submit(setup, "Plan a component");
    await setup.waitForFrame((frame) => frame.includes("Draft component"));
    await submit(setup, "/scan");
    expect(setup.captureCharFrame()).toContain("Draft component");
    expect(setup.captureCharFrame()).toContain("INTENDED");
  } finally {
    setup.renderer.destroy();
  }
});
