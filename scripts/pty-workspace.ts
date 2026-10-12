import { createTerminalScreen } from "./terminal-screen.ts";

interface TerminalOptions {
  command: string | string[];
  cwd: string;
  env: Record<string, string>;
  secrets?: string[];
  timeoutMs?: number;
}

/** Real terminal frames, with bounded output and automatic cleanup on failure. */
export function createWorkspaceTerminal(options: TerminalOptions) {
  const screen = createTerminalScreen(140, 44);
  const decoder = new TextDecoder();
  const listeners = new Set<() => void>();
  let output = "";
  let problem: string | undefined;
  let exitCode: number | undefined;
  const child = Bun.spawn(
    [
      ...(typeof options.command === "string" ? [options.command] : options.command),
      "--renderer",
      "off",
    ],
    {
      cwd: options.cwd,
      env: {
        ...Bun.env,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        OPENROUTER_API_KEY: "",
        VCLI_COMPATIBLE_API_KEY: "",
        VCLI_DEBUG: "",
        BUN_OPTIONS: "",
        BUN_BE_BUN: "",
        NODE_OPTIONS: "",
        TERM: "xterm-256color",
        ...options.env,
      },
      terminal: {
        cols: 140,
        rows: 44,
        data(_terminal, bytes) {
          const text = decoder.decode(bytes, { stream: true });
          output += text;
          screen.update(text);
          if (output.length > 2_000_000) problem = "Terminal output exceeded the smoke limit";
          const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
          if (
            options.secrets?.some(
              (secret) => plain.includes(secret) || screen.text().includes(secret),
            )
          ) {
            problem = "Credential appeared in terminal output";
          }
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
    problem = "Workspace smoke exceeded its deadline";
    child.kill("SIGKILL");
    for (const notify of listeners) notify();
  }, options.timeoutMs ?? 40_000);

  function failure(message: string) {
    let frame = screen.text();
    for (const secret of options.secrets ?? []) frame = frame.replaceAll(secret, "[redacted]");
    return new Error(`${message}: ${frame}`);
  }

  async function waitFor(label: string, after = 0, timeoutMs = 6000) {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        listeners.delete(check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (problem) finish(failure(problem));
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
    // A painted frame can precede the input's focus callback.
    await Bun.sleep(80);
  }

  function write(keys: string) {
    if (problem) throw failure(problem);
    if (!child.terminal) throw failure("PTY is unavailable");
    const offset = output.length;
    child.terminal.write(keys);
    return offset;
  }

  async function submit(text: string, nextLabel: string) {
    const offset = write(`\u0005\u0015${text}\r`);
    await waitFor(nextLabel, offset);
  }

  async function quit() {
    const offset = write("\u0003");
    await waitFor("\u001b[?1049l", offset);
    const code = await child.exited;
    if (code) throw failure(`Workspace client exited with ${code}`);
    if (!output.slice(offset).includes("\u001b[?25h")) throw failure("Cursor was not restored");
  }

  async function close() {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    child.terminal?.close();
  }

  return { waitFor, write, submit, quit, close, visible: () => screen.text(), failure };
}
