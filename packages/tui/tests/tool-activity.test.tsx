import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createRoot } from "solid-js";
import {
  balanced,
  type ArchitectureGraph,
  type ArchitectureService,
  type ChatToolCall,
  type RuntimeEvent,
  type Session,
} from "@vcli/core";
import { createConversation, type Conversation } from "../src/chat/conversation.ts";
import { ToolActivity } from "../src/chat/tool-activity.tsx";
import { sliceToolText, toolPageStride } from "../src/chat/tool-text.ts";
import { Workspace } from "../src/workspace.tsx";

const session: Session = {
  id: "tools",
  root: "/fixture",
  provider: "fixture",
  model: "fixture",
  status: "complete",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  messages: [],
  chat: [],
  ledger: {
    goal: "Test tools",
    constraints: [],
    decisions: [],
    pending: [],
    verification: [],
    touchedPaths: [],
  },
  usage: { input: 0, output: 0, cached: 0 },
};
const graph: ArchitectureGraph = {
  root: "/fixture",
  revision: "one",
  nodes: [{ id: "app", label: "Application", path: "app.ts", kind: "module" }],
  edges: [],
  diagnostics: [],
  cycles: [],
  stats: { files: 0, parsed: 0, cached: 0, durationMs: 0 },
};
const architecture: ArchitectureService = {
  scan: async () => graph,
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  writeDesign: async () => {},
  intendedGraph: () => graph,
  check: () => [],
};
function history(state: ChatToolCall["state"] = "failed"): Session {
  return {
    ...session,
    chat: [
      {
        id: "activity",
        role: "tool",
        createdAt: "now",
        status: state === "failed" ? "failed" : "complete",
        text:
          state === "failed"
            ? "Invalid arguments: design.version expected number 1; received string."
            : "Result preview",
        tool: {
          callId: "call",
          name: "architecture_propose",
          kind: "write",
          target: "architecture.json",
          input: 'design.version: "1"\ncomponents: []',
          state,
          artifact: "artifact-id",
        },
      },
    ],
  };
}
const event = (type: RuntimeEvent["type"], data: RuntimeEvent["data"]): RuntimeEvent => ({
  type,
  data,
  sessionId: session.id,
  time: "now",
});

describe("readable tool activity", () => {
  test("preview and full result page boundaries preserve complete emoji without duplicating text", async () => {
    const content = "a".repeat(toolPageStride - 1) + "😀" + "last page";
    const first = sliceToolText(content, 0, toolPageStride);
    const second = sliceToolText(content, toolPageStride, toolPageStride * 2);
    expect(first + second).toBe(content);
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(second.length).toBeLessThanOrEqual(4000);
    const loaded = history("complete");
    loaded.chat![0]!.text = "b".repeat(179) + "😀preview tail";
    let conversation!: Conversation;
    const setup = await testRender(
      () => {
        conversation = createConversation(loaded, async () => content);
        return <ToolActivity message={conversation.messages()[0]!} conversation={conversation} />;
      },
      { width: 70, height: 30, exitOnCtrlC: false },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("�");
      await conversation.openArtifact("activity");
      conversation.changeArtifactPage(1, "activity");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("😀last page");
      expect(setup.captureCharFrame()).not.toContain("�");
    } finally {
      setup.renderer.destroy();
    }
  });
  test.each([
    ["requested", "Waiting"],
    ["running", "Running"],
    ["complete", "Succeeded"],
    ["failed", "Failed"],
    ["interrupted", "Interrupted"],
    ["blocked", "Blocked"],
  ] as const)("renders %s on a narrow terminal with expandable input", async (state, label) => {
    let conversation!: Conversation;
    const setup = await testRender(
      () => {
        conversation = createConversation(history(state));
        return <ToolActivity message={conversation.messages()[0]!} conversation={conversation} />;
      },
      { width: 48, height: 30, exitOnCtrlC: false },
    );
    try {
      await setup.flush();
      const initial = setup.captureCharFrame();
      expect(initial).toContain(label);
      expect(initial).toContain("Save intended architecture");
      expect(initial).toContain("architecture_propose");
      expect(initial).toContain("architecture.json");
      if (state === "failed") expect(initial).toContain("Invalid arguments");
      expect(initial).not.toContain("design.version:");
      conversation.toggleDetails("activity");
      await setup.flush();
      const expanded = setup.captureCharFrame();
      expect(expanded).toContain("Input");
      expect(expanded).toContain('design.version: "1"');
      expect(expanded).not.toContain("Assistant");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("tool events stay immutable and do not redirect assistant text deltas", () => {
    createRoot((dispose) => {
      try {
        const conversation = createConversation();
        conversation.accept(event("message-start", { messageId: "assistant", role: "assistant" }));
        conversation.accept(event("text", { text: "Before ", messageId: "assistant" }));
        conversation.accept(
          event("tool-request", {
            callId: "call",
            name: "files_read",
            kind: "read",
            arguments: { path: "app.ts" },
          }),
        );
        const requested = conversation.messages().find((message) => message.role === "tool")!;
        conversation.accept(
          event("tool-start", {
            callId: "call",
            name: "files_read",
            kind: "read",
            arguments: { path: "app.ts" },
          }),
        );
        expect(requested.tool?.state).toBe("requested");
        conversation.accept(
          event("tool-end", {
            callId: "call",
            name: "files_read",
            result: "content",
            artifact: "saved",
          }),
        );
        conversation.accept(event("text", { text: "after" }));
        expect(conversation.messages().find((message) => message.id === "assistant")?.text).toBe(
          "Before after",
        );
        expect(conversation.messages().filter((message) => message.role === "tool")).toHaveLength(
          1,
        );
        expect(
          conversation.messages().find((message) => message.role === "tool")?.tool?.state,
        ).toBe("complete");
      } finally {
        dispose();
      }
    });
  });

  test.each([
    ["failed", false],
    ["aborted", false],
    ["failed", true],
    ["aborted", true],
  ] as const)(
    "an unrecorded completion after a %s turn is visibly interrupted (durable snapshot %s)",
    async (outcome, durable) => {
      let conversation!: Conversation;
      const initial = history("running");
      initial.chat![0]!.text = "";
      const setup = await testRender(
        () => {
          conversation = createConversation(initial);
          return <ToolActivity message={conversation.messages()[0]!} conversation={conversation} />;
        },
        { width: 70, height: 20, exitOnCtrlC: false },
      );
      try {
        conversation.finish(durable ? initial : undefined, outcome);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Interrupted");
        expect(frame).toContain("No completion was recorded");
        expect(frame).toContain("Inspect the current state");
        expect(frame).toContain("before retrying");
        expect(initial.chat![0]!.tool!.state).toBe("running");
      } finally {
        setup.renderer.destroy();
      }
    },
  );

  test("keyboard expands restored cards and opens paged artifacts locally without inference", async () => {
    let reads = 0;
    let runs = 0;
    const setup = await testRender(
      () => (
        <Workspace
          root="/fixture"
          graph={graph}
          architecture={architecture}
          permission="yolo"
          renderer="off"
          settings={{
            provider: "compatible",
            model: "fixture",
            credential: "environment",
            permission: "yolo",
            contextWindow: 32768,
            context: { ...balanced },
          }}
          initialSession={history()}
          readArtifact={async (id) => {
            expect(id).toBe("artifact-id");
            reads++;
            return (
              "FIRST PAGE ".repeat(364).slice(0, 4000).padEnd(4000, " ") +
              "SECOND PAGE\napi_key=hidden-key\n\x1b[31munsafe"
            );
          }}
          run={async () => {
            runs++;
            return session;
          }}
        />
      ),
      { width: 76, height: 32, kittyKeyboard: true, exitOnCtrlC: false },
    );
    try {
      setup.mockInput.pressKey("F2");
      setup.mockInput.pressTab();
      setup.mockInput.pressKey("HOME");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Invalid arguments");
      expect(reads).toBe(0);
      setup.mockInput.pressEnter();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain('design.version: "1"');
      expect(setup.captureCharFrame()).toContain("[F] Open full saved result");
      expect(reads).toBe(0);
      setup.mockInput.pressKey("f");
      await setup.waitForFrame((frame) => frame.includes("Page 1/2"));
      expect(reads).toBe(1);
      setup.mockInput.pressArrow("right");
      await setup.waitForFrame((frame) => frame.includes("SECOND PAGE"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Page 2/2");
      expect(frame).not.toContain("hidden-key");
      expect(frame).toContain("\\u001b[31munsafe");
      setup.mockInput.pressKey("f");
      await setup.flush();
      expect(reads).toBe(1);
      expect(runs).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("artifact read failures are readable and retryable; late results never enter another history", async () => {
    let conversation!: Conversation;
    let calls = 0;
    let resolve!: (content: string) => void;
    const setup = await testRender(
      () => {
        conversation = createConversation(history(), async () => {
          calls++;
          if (calls === 1) throw new Error("secret path not displayed");
          return new Promise<string>((finish) => {
            resolve = finish;
          });
        });
        return <ToolActivity message={conversation.messages()[0]!} conversation={conversation} />;
      },
      { width: 70, height: 32, exitOnCtrlC: false },
    );
    try {
      await conversation.openArtifact("activity");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Full result could not be opened. Try again.");
      expect(setup.captureCharFrame()).not.toContain("secret path");
      const pending = conversation.openArtifact("activity");
      expect(conversation.artifacts().activity?.loading).toBe(true);
      conversation.restore(history("complete"));
      resolve("Old conversation output");
      await pending;
      expect(conversation.artifacts()).toEqual({});
      expect(calls).toBe(2);
    } finally {
      setup.renderer.destroy();
    }
  });
});
