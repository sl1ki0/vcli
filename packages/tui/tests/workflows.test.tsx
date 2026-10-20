import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { CodeRenderable, type BaseRenderable } from "@opentui/core";
import {
  createRunPlan,
  decideRunPlan,
  type ArchitectureGraph,
  type ArchitectureService,
  type Session,
} from "@vcli/core";
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

async function finishMarkdown(setup: Awaited<ReturnType<typeof testRender>>) {
  const pending: Promise<void>[] = [];
  function visit(node: BaseRenderable): void {
    if (node instanceof CodeRenderable) pending.push(node.highlightingDone);
    for (const child of node.getChildren()) visit(child);
  }
  visit(setup.renderer.root);
  await Promise.all(pending);
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

test.each([true, false])(
  "plan starts in chat, opens dependencies locally and saves decision %s",
  async (approved) => {
    const plan = createRunPlan(
      {
        goal: "Fix order totals",
        steps: [
          {
            id: "inspect",
            description: "Read order behavior",
            dependencies: [],
            tools: ["files_read"],
            verificationTool: "files_read",
            doneWhen: "Inputs understood",
          },
          {
            id: "fix",
            description: "Correct discount calculation",
            dependencies: ["inspect"],
            tools: ["files_patch"],
            verificationTool: "files_patch",
            doneWhen: "Calculation corrected",
          },
          {
            id: "test",
            description: "Run unchanged tests",
            dependencies: ["fix"],
            tools: ["shell_run"],
            verificationTool: "shell_run",
            doneWhen: "Bash exits zero",
          },
        ],
        risks: ["Invalid discount range"],
        assumptions: ["Tests describe supported behavior"],
        doneWhen: "Original tests pass",
      },
      "plan",
      "2026-10-20T00:00:00.000Z",
    );
    const initial: Session = {
      ...session,
      mode: "plan",
      plan,
      chat: [
        {
          id: `plan:${session.id}:${plan.createdAt}`,
          role: "assistant",
          text:
            "## Execution plan\n\nFix order totals\n\nRead, correct, verify.\n\n" +
            Array.from(
              { length: 30 },
              (_, index) => `Detail ${index + 1}: preserve the public behavior.`,
            ).join("\n\n"),
          status: "complete",
          createdAt: plan.createdAt,
        },
      ],
    };
    const decisions: boolean[] = [];
    let modelCalls = 0;
    const setup = await testRender(
      () => (
        <Workspace
          root="/project"
          graph={graph}
          architecture={architecture}
          renderer="off"
          permission="yolo"
          mode="plan"
          initialSession={initial}
          decidePlan={async (decision) => {
            decisions.push(decision);
            const next = structuredClone(initial);
            decideRunPlan(next.plan!, decision);
            next.mode = decision ? "build" : "plan";
            return next;
          }}
          run={async () => {
            modelCalls++;
            return session;
          }}
        />
      ),
      { width: 120, height: 40, kittyKeyboard: true },
    );
    try {
      await submit(setup, "/plan show");
      await finishMarkdown(setup);
      await setup.waitForFrame(
        (frame) => frame.includes("Fix order totals") && frame.includes("architecture hidden"),
      );
      expect(setup.captureCharFrame()).toContain("Fix order totals");
      expect(setup.captureCharFrame()).toContain("Execution plan");
      expect(setup.captureCharFrame()).not.toContain("STAGE 1");
      await submit(setup, "/plan visual");
      await setup.waitForFrame(
        (frame) =>
          frame.includes("STAGE 3") && frame.includes("← inspect") && frame.includes("← fix"),
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain("STAGE 1");
      expect(frame).toContain("STAGE 3");
      expect(frame).toContain("← inspect");
      expect(frame).toContain("← fix");
      await submit(setup, approved ? "/build" : "/plan reject");
      await setup.waitForFrame(
        (frame) =>
          frame.includes(approved ? "Plan approved" : "Plan rejected") &&
          frame.includes(approved ? "BUILD" : "PLAN"),
      );
      expect(decisions).toEqual([approved]);
      expect(setup.captureCharFrame()).toContain(approved ? "BUILD" : "PLAN");
      expect(setup.captureCharFrame()).toContain(approved ? "Plan approved" : "Plan rejected");
      expect(modelCalls).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  },
);
