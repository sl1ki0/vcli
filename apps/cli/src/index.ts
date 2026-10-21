#!/usr/bin/env bun
import "./workflows/host-filesystem.ts";
import { createArchitectureService } from "@vcli/architecture";
import { configOverrides, parseCliArgs, resolveSettings } from "./args.ts";
import { HELP } from "./help.ts";
import { print, writeOutput } from "./io.ts";
import { interactive } from "./interactive.ts";
import { architectureCommand } from "./commands/architecture.ts";
import { configCommand } from "./commands/config.ts";
import { pluginsCommand } from "./commands/plugins.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { runCommand } from "./commands/run.ts";
import { workflowsCommand } from "./commands/workflows.ts";
import { runOptions } from "./run-options.ts";
import { scopedArchitecture } from "./workflows/architecture-policy.ts";
export { printTree } from "./io.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();
  if (values.help) {
    await print(HELP);
    return;
  }
  const { root, config } = await resolveSettings(values);
  const execution = runOptions(values);
  const architecture = scopedArchitecture(
    createArchitectureService(),
    execution.policyPath,
    execution.stateDirectory,
  );
  const context = { root, config, architecture, values };
  const [command, action, ...rest] = positionals;
  switch (command) {
    case "memory":
    case "hooks":
    case "tasks":
    case "checkpoints":
      return workflowsCommand(command, action, rest, context);
    case "plan":
    case "plans":
      return workflowsCommand("plan", action, rest, context);
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
        ...runOptions(values),
      });
    case undefined:
      return interactive(root, config, architecture, await architecture.scan(root), {
        overrides: configOverrides(values),
        mode: values.plan ? "plan" : "build",
        ...runOptions(values),
      });
    default:
      throw new Error("Unknown command " + command + ". Use --help.");
  }
}
if (import.meta.main)
  main().catch(async (error) => {
    await writeOutput(
      (process.env.VCLI_DEBUG && error instanceof Error
        ? (error.stack ?? error.message)
        : "vcli: " + (error instanceof Error ? error.message : String(error))) + "\n",
      "stderr",
    );
    process.exitCode = 1;
  });
