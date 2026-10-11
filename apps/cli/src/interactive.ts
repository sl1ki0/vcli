import type { ArchitectureGraph, ArchitectureService } from "@vcli/core";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { createHarness } from "./harness.ts";
// Static linking initializes OpenTUI's async module graph in compiled Bun clients.
import { startWorkspace, type WorkspaceOptions } from "@vcli/tui";
import { print, printTree } from "./io.ts";
import { inspectWorkspace } from "./workspace-inspection.ts";
import { createWorkspaceSettings } from "./workspace-settings.ts";
import { credentialScope } from "./credentials.ts";

interface InteractiveOptions {
  overrides?: Partial<Config>;
  initialCommand?: WorkspaceOptions["initialCommand"];
}
interface ProjectWorkspace {
  root: string;
  config: Config;
  graph: ArchitectureGraph;
}

async function openProject(
  path: string,
  from: string,
  architecture: ArchitectureService,
  overrides: Partial<Config>,
): Promise<ProjectWorkspace> {
  const requested = path.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!requested) throw new Error("Enter a project folder path.");
  const expanded = requested.replace(/^~(?=\/|$)/, homedir());
  const root = await realpath(resolve(from, expanded)).catch(() => {
    throw new Error("That folder could not be opened. Check the path and try again.");
  });
  if (!(await stat(root)).isDirectory()) throw new Error("Choose a folder, rather than a file.");
  const config = await loadConfig(root, overrides);
  return { root, config, graph: await architecture.scan(root) };
}

export async function interactive(
  root: string,
  config: Config,
  architecture: ArchitectureService,
  graph: ArchitectureGraph,
  options: InteractiveOptions = {},
) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    print(
      options.initialCommand
        ? "Interactive setup needs a terminal. Use vcli --help for shell configuration commands."
        : printTree(graph),
    );
    return;
  }
  let project: ProjectWorkspace | undefined = { root, config, graph };
  let initialCommand = options.initialCommand;
  let credential: { scope: string; apiKey?: string } | undefined;
  while (project) {
    const current = project;
    let next: ProjectWorkspace | undefined;
    let sessionId: string | undefined;
    const sameProvider = credential?.scope === credentialScope(current.config);
    const settings = createWorkspaceSettings(
      current.root,
      current.config,
      sameProvider ? { apiKey: credential?.apiKey } : {},
    );
    await startWorkspace({
      root: current.root,
      graph: current.graph,
      architecture,
      permission: current.config.permission,
      renderer: current.config.renderer,
      initialCommand,
      settings: await settings.snapshot(),
      configure: settings.configure,
      inspect: (topic) => inspectWorkspace(current.root, topic),
      openProject: async (path) => {
        next = await openProject(path, current.root, architecture, options.overrides ?? {});
      },
      run: async (prompt, signal, emit, approve) => {
        const harness = await createHarness(
          current.root,
          settings.currentConfig(),
          architecture,
          emit,
          approve,
          settings.harnessOptions(),
        );
        try {
          const session = await harness.run(prompt, signal, sessionId);
          sessionId = session.id;
          return session;
        } finally {
          await harness.close();
        }
      },
    });
    credential = {
      scope: credentialScope(settings.currentConfig()),
      apiKey: settings.harnessOptions().apiKey,
    };
    project = next;
    initialCommand = undefined;
  }
}
