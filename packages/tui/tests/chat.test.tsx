import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  CodeRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  type BaseRenderable,
} from "@opentui/core";
import { createRoot } from "solid-js";
import {
  balanced,
  type ArchitectureGraph,
  type ArchitectureService,
  type Session,
  type RuntimeEvent,
  type ToolDefinition,
} from "@vcli/core";
import { Workspace } from "../src/workspace.tsx";
import type {
  WorkspaceOptions,
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
} from "../src/contracts.ts";
import { createConversation, sessionMessages } from "../src/chat/conversation.ts";
import { normalizeChatMarkdown } from "../src/chat/markdown.ts";
import { presentToolRequest } from "../src/chat/tool-request.ts";

const graph: ArchitectureGraph = {
  root: "/sample",
  revision: "a",
  nodes: [{ id: "app", label: "Application", path: "app.ts", kind: "module" }],
  edges: [],
  diagnostics: [],
  cycles: [],
  stats: { files: 1, parsed: 1, cached: 0, durationMs: 1 },
};
const architecture: ArchitectureService = {
  scan: async () => graph,
  readDesign: async () => ({ version: 1, components: [], decisions: [] }),
  writeDesign: async () => {},
  intendedGraph: () => graph,
  check: () => [],
};
const settings: WorkspaceSettings = {
  provider: "compatible",
  model: "fixture",
  credential: "environment",
  permission: "yolo",
  contextWindow: 65536,
  context: { ...balanced },
  reasoning: "default",
};
const session: Session = {
  id: "fixture",
  root: "/sample",
  provider: "compatible",
  model: "fixture",
  status: "complete",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
  ledger: {
    goal: "fixture",
    constraints: [],
    decisions: [],
    pending: [],
    verification: [],
    touchedPaths: [],
  },
  usage: { input: 123, output: 45, cached: 12 },
};
type Setup = Awaited<ReturnType<typeof testRender>>;
const event = (type: RuntimeEvent["type"], data: RuntimeEvent["data"]): RuntimeEvent => ({
  type,
  data,
  sessionId: "fixture",
  time: "now",
});
function render(overrides: Partial<WorkspaceOptions> = {}) {
  return testRender(
    () => (
      <Workspace
        root="/sample"
        graph={graph}
        architecture={architecture}
        permission="yolo"
        renderer="off"
        settings={settings}
        {...overrides}
      />
    ),
    { width: 120, height: 36, kittyKeyboard: true, useMouse: true, exitOnCtrlC: false },
  );
}
async function submit(setup: Setup, text: string) {
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await setup.flush();
}
function input(setup: Setup) {
  const field = setup.renderer.root.findDescendantById("task-input");
  if (!(field instanceof InputRenderable)) throw new Error("Task input missing");
  return field;
}
async function highlighted(setup: Setup) {
  await setup.flush();
  const pending: Promise<void>[] = [];
  function visit(node: BaseRenderable) {
    if (node instanceof CodeRenderable) pending.push(node.highlightingDone);
    for (const child of node.getChildren()) visit(child);
  }
  visit(setup.renderer.root);
  await Promise.all(pending);
  await setup.flush();
}

describe("conversation workspace", () => {
  test.each(["y", "n", "escape", "return"])(
    "tool approval presents an actionable file change and handles %s",
    async (key) => {
      let allowed: boolean | undefined;
      const setup = await render({
        run: async (_prompt, _signal, _emit, approve) => {
          allowed = await approve(
            {
              name: "files_patch",
              kind: "write",
              description: "Replace an exact source span.",
              inputSchema: {},
              execute: async () => ({ text: "unused" }),
            },
            { path: "app.ts", oldText: "value = 1", newText: "value = 2" },
          );
          return session;
        },
      });
      try {
        await submit(setup, "Change the value");
        await setup.waitForFrame((frame) => frame.includes("Permission needed"));
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Review file change");
        expect(frame).toContain("File or directory");
        expect(frame).toContain("app.ts");
        expect(frame).toContain("Before · exact text to replace");
        expect(frame).toContain("value = 1");
        expect(frame).toContain("After · replacement text");
        expect(frame).toContain("value = 2");
        expect(frame).toContain("[Y] Allow once");
        expect(frame).toContain("[N / Esc] Deny");
        expect(frame).not.toContain('"newText":');
        expect(allowed).toBeUndefined();
        if (key === "escape") setup.mockInput.pressEscape();
        else if (key === "return") setup.mockInput.pressEnter();
        else setup.mockInput.pressKey(key);
        await setup.waitForFrame((frame) => !frame.includes("Permission needed"));
        expect(allowed).toBe(key === "y");
        expect(input(setup).value).toBe("");
      } finally {
        setup.renderer.destroy();
      }
    },
  );
  test("long command approvals scroll in a narrow terminal and cancel without permission", async () => {
    let allowed: boolean | undefined;
    const setup = await render({
      run: async (_prompt, _signal, _emit, approve) => {
        allowed = await approve(
          {
            name: "shell_run",
            kind: "execute",
            description: "Run a command.",
            inputSchema: {},
            execute: async () => ({ text: "unused" }),
          },
          {
            command: Array.from({ length: 60 }, (_, index) => `echo command-line-${index}`).join(
              "\n",
            ),
          },
        );
        return session;
      },
    });
    try {
      setup.resize(65, 22);
      await setup.flush();
      await submit(setup, "Run the command");
      await setup.waitForFrame((frame) => frame.includes("Permission needed"));
      expect(setup.captureCharFrame()).toContain("Review command");
      expect(setup.captureCharFrame()).toContain("[Y] Allow once");
      expect(setup.captureCharFrame()).not.toContain("command-line-59");
      setup.mockInput.pressKey("END");
      await setup.waitForFrame((frame) => frame.includes("command-line-59"));
      expect(allowed).toBeUndefined();
      setup.mockInput.pressCtrlC();
      await setup.waitForFrame((frame) => !frame.includes("Permission needed"));
      expect(allowed).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });
  test("sending from scrolled-up history reveals the prompt and later streaming respects manual scrolling", async () => {
    let release!: () => void, finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalChunk = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const loaded = {
      ...session,
      chat: Array.from({ length: 40 }, (_, index) => ({
        id: `old-${index}`,
        role: "user" as const,
        text: `Old message ${index}\n${"A long previous conversation line.\n".repeat(3)}`,
        createdAt: session.createdAt,
        status: "complete" as const,
      })),
    };
    const setup = await render({
      initialSession: loaded,
      run: async (_prompt, _signal, emit) => {
        await gate;
        await emit(event("text", { messageId: "reply", text: "New streamed reply" }));
        await finalChunk;
        await emit(event("text", { messageId: "reply", text: "\nAdditional streamed content" }));
        return session;
      },
    });
    try {
      setup.mockInput.pressKey("F2");
      await setup.flush();
      setup.mockInput.pressTab();
      setup.mockInput.pressKey("HOME");
      await setup.waitForFrame((frame) => frame.includes("Old message 0"));
      const scroll = setup.renderer.root.findDescendantById("chat-history");
      expect(scroll).toBeInstanceOf(ScrollBoxRenderable);
      expect((scroll as ScrollBoxRenderable).scrollHeight).toBeGreaterThan(100);
      setup.mockInput.pressEscape();
      await setup.flush();
      await submit(setup, "New prompt must be visible immediately");
      expect(setup.captureCharFrame()).toContain("New prompt must be visible immediately");
      expect(setup.captureCharFrame()).toContain("Waiting for model");
      release();
      await setup.waitForFrame((frame) => frame.includes("Responding"));
      setup.mockInput.pressTab();
      setup.mockInput.pressKey("HOME");
      await setup.waitForFrame((frame) => frame.includes("Old message 0"));
      const previousScroll = (scroll as ScrollBoxRenderable).scrollTop;
      finish();
      await setup.waitForFrame((frame) => frame.includes("Ready"));
      expect(setup.captureCharFrame()).toContain("Old message 0");
      expect((scroll as ScrollBoxRenderable).scrollTop).toBe(previousScroll);
    } finally {
      release();
      finish();
      setup.renderer.destroy();
    }
  });
  test("Enter keeps an unsent draft with feedback while local layout commands work during a response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const setup = await render({
      run: async () => {
        calls++;
        await gate;
        return session;
      },
    });
    try {
      await submit(setup, "First task");
      await submit(setup, "Keep this unsent draft");
      expect(input(setup).value).toBe("Keep this unsent draft");
      expect(setup.captureCharFrame()).toContain("Response still running; draft kept");
      expect(setup.captureCharFrame()).toContain("1 messages");
      expect(calls).toBe(1);
      setup.mockInput.pressKey("e", { ctrl: true });
      setup.mockInput.pressKey("u", { ctrl: true });
      await submit(setup, "/chat");
      await setup.waitForFrame((frame) => frame.includes("architecture hidden"));
      expect(calls).toBe(1);
      expect(input(setup).value).toBe("");
      release();
      await setup.waitForFrame((frame) => frame.includes("Ready"));
    } finally {
      release();
      setup.renderer.destroy();
    }
  });
  test("sent prompts appear before the model runs and remain across turns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const setup = await render({
      run: async (prompt, _signal, emit) => {
        calls++;
        await gate;
        await emit(event("message-start", { messageId: `u${calls}`, role: "user", text: prompt }));
        await emit(event("message-start", { messageId: `a${calls}`, role: "assistant" }));
        await emit(event("text", { messageId: `a${calls}`, text: `Response ${calls}` }));
        await emit(event("message-end", { messageId: `a${calls}`, status: "complete" }));
        return session;
      },
    });
    try {
      setup.mockInput.pressKey("F2");
      await setup.flush();
      await submit(setup, "First visible prompt");
      expect(setup.captureCharFrame()).toContain("First visible prompt");
      expect(setup.captureCharFrame()).toContain("Waiting for model");
      expect(input(setup).value).toBe("");
      expect(calls).toBe(1);
      release();
      await setup.waitForFrame((frame) => frame.includes("Assistant"));
      await highlighted(setup);
      await setup.waitForFrame((frame) => frame.includes("Response 1") && frame.includes("Ready"));
      await submit(setup, "Second visible prompt");
      await highlighted(setup);
      await setup.waitForFrame((frame) => frame.includes("Response 2"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("First visible prompt");
      expect(frame).toContain("Second visible prompt");
      expect(frame).toContain("4 messages");
      setup.mockInput.pressArrow("up");
      await setup.flush();
      expect(input(setup).value).toBe("Second visible prompt");
      setup.mockInput.pressArrow("up");
      await setup.flush();
      expect(input(setup).value).toBe("First visible prompt");
      setup.mockInput.pressArrow("down");
      await setup.flush();
      expect(input(setup).value).toBe("Second visible prompt");
    } finally {
      release();
      setup.renderer.destroy();
    }
  });
  test("Markdown is formatted and chat can navigate long messages without the architecture", async () => {
    const content =
      "# Heading\n\n** Strong text ** and `literal` with *emphasis*.\n\n- first item\n- second item\n\n```ts\nconst value = 1;\n```\n\n| Module | Purpose |\n| --- | --- |\n| app | UI |";
    const loaded = {
      ...session,
      chat: [
        {
          id: "user",
          role: "user" as const,
          text: "A prior question",
          createdAt: "now",
          status: "complete" as const,
        },
        {
          id: "answer",
          role: "assistant" as const,
          text: content,
          reasoning: "Visible provider reasoning",
          createdAt: "now",
          status: "complete" as const,
        },
      ],
    };
    const setup = await render({ initialSession: loaded });
    try {
      setup.mockInput.pressKey("F2");
      await highlighted(setup);
      await setup.waitForFrame((frame) => frame.includes("Strong text"));
      expect(setup.captureCharFrame()).not.toContain("**");
      expect(setup.captureCharFrame()).not.toContain("`literal`");
      expect(setup.captureCharFrame()).toContain("const value = 1");
      expect(setup.captureCharFrame()).toContain("Module");
      expect(setup.captureCharFrame()).toContain("architecture hidden");
      expect(setup.renderer.root.findDescendantById("architecture-image")).toBeUndefined();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(
        spans.some((span) => span.text.includes("Strong text") && Boolean(span.attributes & 1)),
      ).toBe(true);
      expect(
        spans.some((span) => span.text.includes("literal") && span.fg.r > 0.9 && span.fg.b < 0.3),
      ).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("Visible provider reasoning");
      setup.mockInput.pressTab();
      setup.mockInput.pressKey("HOME");
      await setup.waitForFrame((frame) => frame.includes("› You"));
      setup.mockInput.pressKey("END");
      await setup.waitForFrame((frame) => frame.includes("› Assistant"));
      setup.mockInput.pressKey(" ");
      await highlighted(setup);
      await setup.waitForFrame((frame) => frame.includes("Visible provider reasoning"));
      setup.mockInput.pressEnter();
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("Visible provider reasoning");
      setup.resize(65, 22);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Chat");
      setup.mockInput.pressEscape();
      await setup.flush();
      await setup.mockInput.typeText("Draft");
      expect(input(setup).value).toBe("Draft");
    } finally {
      setup.renderer.destroy();
    }
  });
  test("history restores messages, refreshes architecture and starts a separate conversation locally", async () => {
    let opened = "",
      created = 0,
      scans = 0,
      inference = 0;
    const saved = {
      ...session,
      id: "saved",
      chat: [
        {
          id: "old-user",
          role: "user" as const,
          text: "Saved prompt",
          createdAt: "now",
          status: "complete" as const,
        },
      ],
    };
    const setup = await render({
      architecture: {
        ...architecture,
        scan: async () => {
          scans++;
          return graph;
        },
      },
      sessions: {
        list: async () => [
          {
            id: "saved",
            title: "Saved prompt",
            provider: "compatible",
            model: "fixture",
            status: "complete",
            updatedAt: session.updatedAt,
            tokens: 168,
          },
        ],
        open: async (id) => {
          opened = id;
          return saved;
        },
        create: () => {
          created++;
        },
      },
      run: async () => {
        inference++;
        return session;
      },
    });
    try {
      await submit(setup, "/history");
      await setup.waitForFrame((frame) => frame.includes("2. Saved prompt"));
      setup.mockInput.pressKey("2");
      await setup.waitForFrame(
        (frame) => frame.includes("Saved prompt") && frame.includes("Resumed conversation"),
      );
      expect(opened).toBe("saved");
      expect(scans).toBeGreaterThan(0);
      expect(setup.captureCharFrame()).toContain("168 tokens");
      await submit(setup, "/new");
      await setup.waitForFrame((frame) => frame.includes("New conversation"));
      expect(created).toBe(1);
      expect(setup.captureCharFrame()).not.toContain("Saved prompt");
      expect(inference).toBe(0);
      expect(input(setup).value).toBe("");
    } finally {
      setup.renderer.destroy();
    }
  });
  test.each(["open", "create"] as const)(
    "session %s commits before Escape or another task can change the workspace",
    async (operation) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let selected = 0,
        calls = 0;
      const restored = {
        ...session,
        chat: [
          {
            id: "saved",
            role: "user" as const,
            text: "Safely selected",
            createdAt: "now",
            status: "complete" as const,
          },
        ],
      };
      const setup = await render({
        sessions: {
          list: async () => [
            {
              id: "saved",
              title: "Saved prompt",
              provider: "compatible",
              model: "fixture",
              status: "complete",
              updatedAt: session.updatedAt,
              tokens: 168,
            },
          ],
          open: async () => {
            selected++;
            await gate;
            return restored;
          },
          create: async () => {
            selected++;
            await gate;
          },
        },
        run: async () => {
          calls++;
          return session;
        },
      });
      try {
        await submit(setup, "/history");
        await setup.waitForFrame((frame) => frame.includes("2. Saved prompt"));
        setup.mockInput.pressKey(operation === "open" ? "2" : "1");
        await setup.flush();
        expect(selected).toBe(1);
        setup.mockInput.pressEscape();
        setup.mockInput.pressKey("F1");
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Conversation history");
        expect(setup.renderer.root.findDescendantById("task-input")).toBeUndefined();
        await setup.mockInput.typeText("Do not start a competing task");
        setup.mockInput.pressEnter();
        await setup.flush();
        expect(calls).toBe(0);
        expect(selected).toBe(1);
        release();
        await setup.waitForFrame((frame) =>
          frame.includes(operation === "open" ? "Safely selected" : "New conversation."),
        );
        expect(input(setup).value).toBe("");
      } finally {
        release();
        setup.renderer.destroy();
      }
    },
  );
  test("keyboard selection scrolls long session lists into view in narrow terminals", async () => {
    const setup = await render({
      sessions: {
        list: async () =>
          Array.from({ length: 30 }, (_, index) => ({
            id: `s${index}`,
            title: `Saved conversation ${index}`,
            provider: "compatible",
            model: "fixture",
            status: "complete",
            updatedAt: session.updatedAt,
            tokens: 168,
          })),
        open: async () => session,
        create: () => {},
      },
    });
    try {
      setup.resize(65, 22);
      await setup.flush();
      await submit(setup, "/history");
      await setup.waitForFrame((frame) => frame.includes("2. Saved conversation 0"));
      for (let index = 0; index < 15; index++) {
        setup.mockInput.pressArrow("down");
        await setup.flush();
      }
      await setup.waitForFrame((frame) => frame.includes("› 16. Saved conversation 14"));
      expect(setup.captureCharFrame()).not.toContain("› 1. New conversation");
    } finally {
      setup.renderer.destroy();
    }
  });
  test("reasoning choices and the OpenRouter connection remain local", async () => {
    const updates: WorkspaceSettingsUpdate[] = [];
    const setup = await render({
      configure: async (update) => {
        updates.push(update);
        return update.kind === "reasoning"
          ? { ...settings, reasoning: update.reasoning }
          : settings;
      },
    });
    try {
      await submit(setup, "/reasoning");
      expect(setup.captureCharFrame()).toContain("Reasoning effort");
      setup.mockInput.pressKey("6");
      await setup.waitForFrame((frame) => frame.includes("Reasoning effort saved"));
      expect(updates).toEqual([{ kind: "reasoning", reasoning: "high" }]);
      await submit(setup, "/connect");
      expect(setup.captureCharFrame()).toContain("5. OpenRouter");
      setup.mockInput.pressKey("5");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("vendor/model");
      setup.mockInput.pressEscape();
      await setup.flush();
      expect(updates).toHaveLength(1);
    } finally {
      setup.renderer.destroy();
    }
  });
  test("a failed preflight prompt remains visible after the next successful durable reply", async () => {
    let calls = 0;
    const setup = await render({
      run: async (prompt) => {
        if (++calls === 1) throw new Error("Connection preflight failed");
        const time = new Date().toISOString();
        return {
          ...session,
          chat: [
            {
              id: "committed-user",
              role: "user",
              text: prompt,
              createdAt: time,
              status: "complete",
            },
            {
              id: "committed-answer",
              role: "assistant",
              text: "Successful reply",
              createdAt: time,
              status: "complete",
            },
          ],
        };
      },
    });
    try {
      setup.mockInput.pressKey("F2");
      await setup.flush();
      await submit(setup, "Failed prompt remains");
      await setup.waitForFrame((frame) => frame.includes("You · failed"));
      await submit(setup, "Successful follow-up");
      await setup.waitForFrame((frame) => frame.includes("Assistant"));
      await highlighted(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Failed prompt remains");
      expect(frame).toContain("You · failed");
      expect(frame).toContain("Successful reply");
      await submit(setup, "/new");
      await setup.waitForFrame((value) => value.includes("New conversation."));
      expect(setup.captureCharFrame()).not.toContain("Failed prompt remains");
    } finally {
      setup.renderer.destroy();
    }
  });
  test.each(["failed", "aborted"] as const)(
    "partial replies survive %s requests",
    async (status) => {
      const setup = await render({
        run: async (_prompt, signal, emit) => {
          await emit(event("text", { text: "Partial reply" }));
          if (status === "aborted")
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          throw new Error("Fixture failure");
        },
      });
      try {
        setup.mockInput.pressKey("F2");
        await setup.flush();
        await submit(setup, "Please respond");
        await highlighted(setup);
        await setup.waitForFrame((frame) => frame.includes("Partial reply"));
        if (status === "aborted") setup.mockInput.pressCtrlC();
        await setup.waitForFrame((frame) =>
          frame.includes(status === "aborted" ? "Canceled" : "Failed"),
        );
        expect(setup.captureCharFrame()).toContain("Partial reply");
        expect(setup.captureCharFrame()).toContain("Please respond");
      } finally {
        setup.renderer.destroy();
      }
    },
  );
});

test("conversation reconciliation retains exact durable turns and hides empty tool-only assistant replies", () => {
  createRoot((dispose) => {
    try {
      const conversation = createConversation();
      conversation.send("Prompt");
      conversation.accept(
        event("message-start", { role: "user", messageId: "durable-user", text: "Prompt" }),
      );
      conversation.accept(event("message-start", { role: "assistant", messageId: "tool-only" }));
      conversation.accept(event("message-end", { messageId: "tool-only", status: "complete" }));
      conversation.accept(event("message-start", { role: "assistant", messageId: "reply" }));
      conversation.accept(event("reasoning", { messageId: "reply", text: "Thinking" }));
      conversation.accept(event("text", { messageId: "reply", text: "Answer" }));
      conversation.finish(undefined, "aborted");
      expect(conversation.messages()).toHaveLength(3);
      expect(conversation.visibleMessages()).toHaveLength(2);
      expect(conversation.messages()[0]?.id).toBe("durable-user");
      expect(conversation.messages()[2]).toMatchObject({
        text: "Answer",
        reasoning: "Thinking",
        status: "aborted",
      });
      expect(
        sessionMessages({
          ...session,
          messages: [
            { role: "user", text: "Legacy prompt" },
            { role: "assistant", text: "Legacy answer" },
            { role: "tool", text: "hidden", toolCallId: "t" },
          ],
        }).map((message) => message.text),
      ).toEqual(["Legacy prompt", "Legacy answer"]);
    } finally {
      dispose();
    }
  });
});
test("spaced bold is normalized only outside escaped markers and literal code", () => {
  expect(
    normalizeChatMarkdown(
      "** Text ** `** literal **`\n```ts\n** literal **\n```\n\\** escaped **\n    ** indented **",
    ),
  ).toBe(
    "**Text** `** literal **`\n```ts\n** literal **\n```\n\\** escaped **\n    ** indented **",
  );
});

test("tool requests retain long arguments, readable nested fields and visible control characters", () => {
  const tool: ToolDefinition = {
    name: "mcp.custom",
    kind: "write",
    description: "Update a remote record.",
    inputSchema: {},
    execute: async () => ({ text: "unused" }),
  };
  const request = presentToolRequest(tool, {
    record: { title: "hello\u001b[31m", options: [true, false] },
    content: "full-content\n".repeat(100),
  });
  expect(request.title).toBe("Review tool request");
  expect(request.fields[1]?.text).toBe("title: hello\\u001b[31m\noptions: • Yes\n  • No");
  expect(request.fields[2]?.text).toHaveLength(1300);
  expect(
    presentToolRequest({ ...tool, name: "files_patch" }, { path: "file.ts", newText: "" })
      .fields[2],
  ).toMatchObject({ label: "File content", text: "(empty text)", tone: "added" });
});
