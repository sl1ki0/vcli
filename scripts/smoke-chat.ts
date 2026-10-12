import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

const KEY = "chat_fixture_local_secret";
const MODEL = "chat-fixture";
const FIRST_PROMPT = "Describe the architecture and format your answer.";
const SECOND_PROMPT = "Keep this conversation and explain the next step.";
const NEW_PROMPT = "Start a separate conversation about verification.";
const FIRST_RESPONSE =
  "# Chat result\n\n**Bold statement** and `inlineValue`.\n\n- First list item\n- Second list item\n\n```ts\nconst answer = 42;\n```\n";

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

/** Public chat workflow, using the real renderer and a local streaming provider. */
export async function chatSmoke(command: string | string[]) {
  const directory = await mkdtemp(join(tmpdir(), "vcli-chat-"));
  const project = join(directory, "project");
  const home = join(directory, "configuration");
  await mkdir(join(project, ".vcli"), { recursive: true });
  await mkdir(home);
  await writeFile(join(project, "app.ts"), "export const ready = true;\n");

  let releaseFirst!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${KEY}`) {
        return new Response("Fixture credentials were not supplied", { status: 401 });
      }
      const body = (await request.json()) as ModelRequest;
      requests.push(body);
      const number = requests.length;
      if (number === 1) await firstResponseGate;
      const response =
        number === 1
          ? FIRST_RESPONSE
          : number === 2
            ? "Second response stays in the same conversation."
            : "Separate conversation is ready.";
      const pieces = response.match(/[\s\S]{1,24}/g) ?? [];
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const content of pieces) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              await Bun.sleep(10);
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 80, completion_tokens: 25 },
                })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(project, ".vcli/config.json"),
    JSON.stringify({
      provider: "compatible",
      model: MODEL,
      baseURL: server.url.origin,
    }),
  );
  const options = {
    command,
    cwd: project,
    env: {
      VCLI_CONFIG_HOME: home,
      VCLI_COMPATIBLE_API_KEY: KEY,
    },
    secrets: [KEY],
  };
  let terminal = createWorkspaceTerminal(options);

  async function openOlderConversation() {
    await terminal.submit("/history", "Conversation history");
    await terminal.waitFor(FIRST_PROMPT);
    await terminal.waitFor("Resumed conversation", terminal.write("3"));
    // The history opens at the latest message; navigate to the first user turn.
    const offset = terminal.write("\t\u001b[H");
    await terminal.waitFor(FIRST_PROMPT, offset);
    await terminal.waitFor("Bold statement");
    terminal.write("\u001b");
    await Bun.sleep(80);
  }

  try {
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await terminal.submit(FIRST_PROMPT, "Waiting for model");
    if (!terminal.visible().includes(FIRST_PROMPT)) {
      throw terminal.failure("Sent message was not visible before the model responded");
    }
    releaseFirst();
    await terminal.waitFor("const answer = 42;");
    await terminal.waitFor("Ready");
    const formatted = terminal.visible();
    if (formatted.includes("**Bold statement**") || formatted.includes("`inlineValue`")) {
      throw terminal.failure("Markdown delimiters were displayed instead of rendered formatting");
    }
    await terminal.submit(SECOND_PROMPT, "Second response stays");
    await terminal.waitFor("Ready");
    if (!terminal.visible().includes(FIRST_PROMPT)) {
      throw terminal.failure("Sending another message erased the visible conversation");
    }
    await terminal.submit("/new", "Chat");
    await terminal.submit(NEW_PROMPT, "Separate conversation is ready.");
    await terminal.waitFor("Ready");
    await openOlderConversation();
    if (requests.length !== 3 || requests.some((request) => request.model !== MODEL)) {
      throw new Error("History navigation made a model call or selected the wrong model");
    }
    const secondContext = JSON.stringify(requests[1]!.messages);
    const newContext = JSON.stringify(requests[2]!.messages);
    if (!secondContext.includes(FIRST_PROMPT) || !secondContext.includes("Bold statement")) {
      throw new Error("The second turn lost the active conversation context");
    }
    if (newContext.includes(FIRST_PROMPT) || newContext.includes(SECOND_PROMPT)) {
      throw new Error("New conversation retained the previous task context");
    }
    await terminal.quit();
    await terminal.close();
    terminal = createWorkspaceTerminal(options);
    await terminal.waitFor("vcli");
    await terminal.submit("/chat", "Chat");
    await openOlderConversation();
    if (requests.length !== 3) throw new Error("Restoring persisted history made a model call");
    await terminal.quit();
    return {
      modelRequests: requests.length,
      formattedChat: true,
      persistedHistory: true,
      terminalRestored: true,
    };
  } finally {
    releaseFirst();
    await terminal.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
