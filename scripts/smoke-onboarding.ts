import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalScreen } from "./terminal-screen.ts";

const TYPED_KEY = "onboarding_typed_fixture_";
const PASTED_KEY = "pasted_secret_7392";
const API_KEY = TYPED_KEY + PASTED_KEY;
const MODEL = "onboarding-fixture";
const PROMPT_BUDGET = 12_288;

function redact(text: string): string {
  for (const secret of [API_KEY, TYPED_KEY, PASTED_KEY]) {
    text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

function plainText(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Exercises public first-run flows in a real PTY with an isolated local model. */
export async function onboardingSmoke(command: string | string[]) {
  const directory = await mkdtemp(join(tmpdir(), "vcli-first-run-"));
  const artifacts = join(directory, "exported-artifacts");
  const project = join(directory, "source-project");
  const home = join(directory, "configuration");
  await mkdir(artifacts);
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(home);
  await writeFile(join(artifacts, "architecture.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "onboarding-project", type: "module" }),
  );
  await writeFile(join(project, "src/onboarding.ts"), "export const ready = true;\n");

  let modelRequests = 0;
  let authorized = false;
  let correctModel = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { model?: string };
      modelRequests++;
      authorized = request.headers.get("authorization") === `Bearer ${API_KEY}`;
      correctModel = body.model === MODEL;
      const chunks = [
        {
          choices: [
            { index: 0, delta: { content: "Onboarding fixture complete." }, finish_reason: "stop" },
          ],
        },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  let output = "";
  let terminalFailure: string | undefined;
  let exitCode: number | undefined;
  const decoder = new TextDecoder();
  const screen = createTerminalScreen(140, 42);
  const listeners = new Set<() => void>();
  const child = Bun.spawn(
    [...(typeof command === "string" ? [command] : command), "--renderer", "off"],
    {
      cwd: artifacts,
      env: {
        ...Bun.env,
        VCLI_CONFIG_HOME: home,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        VCLI_COMPATIBLE_API_KEY: "",
        VCLI_DEBUG: "",
        BUN_OPTIONS: "",
        NODE_OPTIONS: "",
        TERM: "xterm-256color",
      },
      terminal: {
        cols: 140,
        rows: 42,
        data(_terminal, bytes) {
          const text = decoder.decode(bytes, { stream: true });
          output += text;
          screen.update(text);
          if (
            [API_KEY, TYPED_KEY, PASTED_KEY].some(
              (secret) => plainText(output).includes(secret) || screen.text().includes(secret),
            )
          ) {
            terminalFailure = "API key appeared in terminal output";
          }
          if (output.length > 2_000_000)
            terminalFailure = "Terminal output exceeded the smoke limit";
          for (const notify of listeners) notify();
        },
      },
    },
  );
  void child.exited.then((code) => {
    exitCode = code;
    for (const notify of listeners) notify();
  });
  const deadline = setTimeout(() => {
    terminalFailure = "First-run smoke exceeded its deadline";
    child.kill("SIGKILL");
    for (const notify of listeners) notify();
  }, 30_000);

  function failure(message: string): Error {
    return new Error(`${message}: ${redact(screen.text())}`);
  }

  async function waitFor(label: string, after = 0, timeoutMs = 4000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        listeners.delete(check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (terminalFailure) finish(failure(terminalFailure));
        else if (
          output.length > after &&
          (label.includes("\u001b")
            ? output.slice(after).includes(label)
            : screen.text().includes(label))
        )
          finish();
        else if (exitCode !== undefined)
          finish(failure(`Client exited (${exitCode}) before ${label}`));
      };
      const timer = setTimeout(() => finish(failure(`Timed out waiting for ${label}`)), timeoutMs);
      listeners.add(check);
      check();
    });
    // A painted title can precede the input's mount/focus callback by one frame.
    await Bun.sleep(80);
  }

  function write(keys: string): number {
    if (terminalFailure) throw failure(terminalFailure);
    if (!child.terminal) throw failure("PTY is unavailable");
    const after = output.length;
    child.terminal.write(keys);
    return after;
  }

  async function openPanel(command: string, title: string) {
    write("\u001b");
    await Bun.sleep(100);
    const after = write(`\u0005\u0015${command}\r`);
    await waitFor(title, after);
  }

  async function choose(key: string, nextLabel: string) {
    await waitFor(nextLabel, write(key));
  }

  async function fill(value: string, nextLabel: string) {
    await waitFor(nextLabel, write(`\u0005\u0015${value}\r`));
  }

  try {
    await waitFor("Welcome to vcli");
    if (
      !output.includes("Open project") ||
      !output.includes("Connect provider") ||
      !output.includes("No source files were found")
    ) {
      throw failure("Empty source folder did not show actionable welcome commands");
    }

    await openPanel("/help", "Help / commands");
    if (!output.includes("/tokens")) throw failure("Help did not expose token settings");
    await openPanel("/open", "Open project");
    await fill(project, "source-project ·");
    await waitFor("onboarding.ts", write("\u001b"));

    await openPanel("/connect", "Connect provider");
    await choose("4", "Model ID");
    await fill(MODEL, "Endpoint URL");
    await fill(server.url.origin, "API key");
    write(TYPED_KEY);
    await Bun.sleep(100);
    write(`\u001b[200~${PASTED_KEY}\u001b[201~`);
    await waitFor("••");
    await choose("\r", "Key storage");
    await choose("2", "Connection saved");

    await openPanel("/tokens", "Token budgets");
    await choose("2", "Target input budget.");
    await fill(String(PROMPT_BUDGET), "Save token budgets");
    await choose("9", "Token budgets saved");

    const configText = await readFile(join(project, ".vcli/config.json"), "utf8");
    const config = JSON.parse(configText);
    if (
      config.provider !== "compatible" ||
      config.model !== MODEL ||
      config.baseURL !== server.url.origin ||
      config.context.promptTokens !== PROMPT_BUDGET
    ) {
      throw new Error("First-run settings were not persisted to the opened project");
    }
    if (configText.includes(API_KEY)) throw new Error("API key leaked into project settings");
    const keyFile = join(home, "credentials.json");
    if (!Object.values(JSON.parse(await readFile(keyFile, "utf8")).keys).includes(API_KEY)) {
      throw new Error("The selected local credential save did not persist the key");
    }
    if (process.platform !== "win32" && ((await stat(keyFile)).mode & 0o777) !== 0o600) {
      throw new Error("The saved key file is not restricted to the current user");
    }

    write("\u001b");
    await Bun.sleep(100);
    await waitFor(
      "Onboarding fixture complete.",
      write("Say hello using the configured local model.\r"),
    );
    await waitFor("complete");
    if (modelRequests !== 1 || !authorized || !correctModel) {
      throw new Error("The configured provider/model/key did not reach the local SDK fixture");
    }

    const quitOffset = write("\u0003");
    await waitFor("\u001b[?1049l", quitOffset);
    const code = await child.exited;
    if (code) throw failure(`First-run client exited with ${code}`);
    const cleanup = output.slice(quitOffset);
    if (!cleanup.includes("\u001b[?1049l") || !cleanup.includes("\u001b[?25h")) {
      throw failure("First-run client did not restore the terminal screen and cursor");
    }
    if (terminalFailure) throw failure(terminalFailure);
    return {
      modelRequests,
      promptTokens: config.context.promptTokens as number,
      terminalRestored: true,
    };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    child.terminal?.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
