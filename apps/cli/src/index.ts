#!/usr/bin/env bun
import { createArchitectureService } from "@vcli/architecture";
import { configOverrides, parseCliArgs, resolveSettings } from "./args.ts";
import { HELP } from "./help.ts";
import { print } from "./io.ts";
import { interactive } from "./interactive.ts";
import { architectureCommand } from "./commands/architecture.ts";
import { configCommand } from "./commands/config.ts";
import { pluginsCommand } from "./commands/plugins.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { runCommand } from "./commands/run.ts";
export { printTree } from "./io.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();
  if (values.help) {
    print(HELP);
    return;
  }
  const { root, config } = await resolveSettings(values);
  const architecture = createArchitectureService();
  const context = { root, config, architecture, values };
  const [command, action, ...rest] = positionals;
  switch (command) {
    case "architecture":
      return architectureCommand(action, rest, context);
    case "config":
      return configCommand(action, rest, context);
    case "plugins":
      return pluginsCommand(action, rest, context);
    case "sessions":
      return sessionsCommand(action, rest, context);
    case "run":
      return runCommand([action, ...rest].filter(Boolean).join(" "), undefined, context);
    case "setup":
      return interactive(root, config, architecture, await architecture.scan(root), {
        overrides: configOverrides(values),
        initialCommand: "/connect",
      });
    case undefined:
      return interactive(root, config, architecture, await architecture.scan(root), {
        overrides: configOverrides(values),
      });
    default:
      throw new Error("Unknown command " + command + ". Use --help.");
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(
      process.env.VCLI_DEBUG
        ? error
        : "vcli: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  });
