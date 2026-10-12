import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTerminal } from "./pty-workspace.ts";

const TYPED_KEY = "onboarding_typed_fixture_";
const PASTED_KEY = "pasted_secret_7392";
const API_KEY = TYPED_KEY + PASTED_KEY;
const MODEL = "onboarding-fixture";
const PROMPT_BUDGET = 12_288;

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

  const terminal = createWorkspaceTerminal({
    command,
    cwd: artifacts,
    env: { VCLI_CONFIG_HOME: home },
    secrets: [API_KEY, TYPED_KEY, PASTED_KEY],
    timeoutMs: 30_000,
  });
  const { write, waitFor, failure } = terminal;

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
      !terminal.visible().includes("Open project") ||
      !terminal.visible().includes("Connect provider") ||
      !terminal.visible().includes("No source files were found")
    ) {
      throw failure("Empty source folder did not show actionable welcome commands");
    }

    await openPanel("/help", "Help / commands");
    if (!terminal.visible().includes("/tokens"))
      throw failure("Help did not expose token settings");
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

    await terminal.quit();
    return {
      modelRequests,
      promptTokens: config.context.promptTokens as number,
      terminalRestored: true,
    };
  } finally {
    await terminal.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
