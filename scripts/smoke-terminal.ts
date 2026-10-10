import { join } from "node:path";

/** Runs a client in a PTY, independently of any installed terminal app. */
export async function terminalSmoke(
  command: string | string[],
  directory: string,
  protocol: "off" | "kitty",
) {
  let output = "",
    sentQuit = false,
    timedOut = false;
  const child = Bun.spawn(
    [...(typeof command === "string" ? [command] : command), "--renderer", protocol],
    {
      cwd: directory,
      env: {
        ...Bun.env,
        VCLI_CONFIG_HOME: join(directory, "configuration"),
        TERM: "xterm-256color",
      },
      terminal: {
        cols: 120,
        rows: 35,
        data(terminal, bytes) {
          output = (output + new TextDecoder().decode(bytes)).slice(-2_000_000);
          const ready =
            protocol === "off"
              ? output.includes("Architecture observed")
              : /\u001b_G[^;]*a=[tT][^;]*;/.test(output);
          if (ready && !sentQuit) {
            sentQuit = true;
            terminal.write("\tq");
          }
        },
      },
    },
  );
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15_000);
  try {
    const code = await child.exited;
    if (timedOut || code || !sentQuit)
      throw new Error(`Terminal ${protocol} failed (${code}): ${output.slice(-1200)}`);
    if (!output.includes("\u001b[?1049l") || !output.includes("\u001b[?25h"))
      throw new Error("Terminal did not restore screen/cursor state");
  } finally {
    clearTimeout(timer);
    child.terminal?.close();
  }
}
