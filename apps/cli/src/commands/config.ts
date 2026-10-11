import { setConfig } from "../config.ts";
import { print } from "../io.ts";
import type { CommandContext } from "./context.ts";
export async function configCommand(
  action: string | undefined,
  rest: string[],
  context: CommandContext,
) {
  const { root, config, architecture, values } = context;

  if (!action || action === "show") await print(config);
  else if (action === "set") {
    const [key, ...parts] = rest;
    if (!key || !parts.length) throw new Error("Usage: vcli config set <key> <value>");
    const raw = parts.join(" ");
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {}
    await setConfig(root, key, value, values.project);
    await print(`Saved ${key}.`);
  } else throw new Error("Unknown config command");
  return;
}
