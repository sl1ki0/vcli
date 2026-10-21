import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { escapeTerminalText } from "@vcli/core";

const rowCount = 2048;
const text = "Модуль 💡 " + "x".repeat(512);
const rows = Array.from({ length: rowCount }, (_, index) => ({ index, text }));
const data = {
  rows,
  apiKey: "private-output-fixture-key",
  env: { PRIVATE: "private-output-fixture-environment" },
  headers: { Authorization: "private-output-fixture-header" },
};
const expected =
  JSON.stringify(
    {
      ...data,
      apiKey: "[configured]",
      env: { PRIVATE: "[configured]" },
      headers: { Authorization: "[configured]" },
    },
    null,
    2,
  ) + '\n{"sequence":1,"text":"first"}\n{"sequence":2,"text":"last"}\n';

async function readDelayed(command: string[], directory: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: directory,
    env: { ...Bun.env, BUN_OPTIONS: "", BUN_BE_BUN: "", NODE_OPTIONS: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10_000);
  const stderr = new Response(child.stderr).text();
  try {
    // Fill the pipe before consuming it to exercise write backpressure.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [stdout, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      stderr,
      child.exited,
    ]);
    expect(timedOut).toBe(false);
    expect(code).toBe(0);
    expect(errors).toBe("");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

test("source and compiled output drains large JSON and ordered events before exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-output-"));
  const fixture = join(directory, "output.ts");
  const binary = join(directory, "output-client");
  const io = resolve(import.meta.dir, "../apps/cli/src/io.ts");
  try {
    await writeFile(
      fixture,
      `import { print, writeOutput } from ${JSON.stringify(io)};
await print(${JSON.stringify(data)});
await writeOutput('{"sequence":1,"text":"first"}\\n');
await writeOutput('{"sequence":2,"text":"last"}\\n');
process.exit(0);
`,
    );
    const build = await Bun.build({
      entrypoints: [fixture],
      target: "bun",
      compile: {
        outfile: binary,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    });
    expect(build.success).toBe(true);
    for (const command of [[process.execPath, fixture], [binary]]) {
      const stdout = await readDelayed(command, directory);
      expect(stdout.length).toBeGreaterThan(1_000_000);
      expect(stdout).toBe(expected);
      expect(stdout).not.toContain("\u001b");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("CLI output and errors render untrusted terminal controls as literal text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-output-controls-"));
  const io = resolve(import.meta.dir, "../apps/cli/src/io.ts");
  const unsafe = "text\u001b]52;c;clipboard\u0007\u009b2J\r\u202eend";
  try {
    const fixture = join(directory, "controls.ts");
    await writeFile(
      fixture,
      `import { print, writeOutput } from ${JSON.stringify(io)};
await print(${JSON.stringify(unsafe)});
await writeOutput(${JSON.stringify(unsafe)}, "stderr");
`,
    );
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe(escapeTerminalText(unsafe) + "\n");
    expect(stderr).toBe(escapeTerminalText(unsafe));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI approval exposes the entire command including its tail and escapes terminal instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-cli-approval-"));
  const io = resolve(import.meta.dir, "../apps/cli/src/io.ts");
  const command = "printf harmless " + "x".repeat(1200) + "; tail-must-be-reviewed\u009b2J";
  let output = "",
    answered = false;
  try {
    const fixture = join(directory, "approval.ts");
    await writeFile(
      fixture,
      `import { confirm } from ${JSON.stringify(io)};
const allowed = await confirm({ name: "shell_run", kind: "execute" } as any, { command: ${JSON.stringify(command)} });
console.log("DECISION:" + allowed);
`,
    );
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: directory,
      terminal: {
        cols: 100,
        rows: 24,
        data(terminal, bytes) {
          output += new TextDecoder().decode(bytes);
          if (!answered && output.includes("[y/N]")) {
            answered = true;
            terminal.write("n\n");
          }
        },
      },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await child.exited).toBe(0);
      expect(answered).toBe(true);
      expect(output).toContain("tail-must-be-reviewed\\u009b2J");
      expect(output).not.toContain("\u009b");
      expect(output).toContain("DECISION:false");
    } finally {
      clearTimeout(timer);
      child.terminal?.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
