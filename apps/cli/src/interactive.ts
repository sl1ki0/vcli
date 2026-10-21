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
import { createWorkspaceHistory } from "./workspace-history.ts";
import { rewindCheckpoint } from "./workflows/inspection.ts";
import { SqliteSessionStore } from "./store.ts";
import { decidePlan } from "./workflows/run-controls.ts";

interface InteractiveOptions {
  overrides?: Partial<Config>;
  initialCommand?: WorkspaceOptions["initialCommand"];
  mode?: "build" | "plan";
  policyPath?: string;
  stateDirectory?: string;
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
    await print(
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
    let mode = options.mode ?? "build";
    const sameProvider = credential?.scope === credentialScope(current.config);
    const settings = createWorkspaceSettings(
      current.root,
      current.config,
      sameProvider ? { apiKey: credential?.apiKey } : {},
    );
    let activeHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
    await startWorkspace({
      root: current.root,
      graph: current.graph,
      architecture,
      permission: current.config.permission,
      renderer: current.config.renderer,
      initialCommand,
      settings: await settings.snapshot(),
      configure: async (update) => {
        const snapshot = await settings.configure(update);
        if (update.kind === "permission") activeHarness?.setPermission(snapshot.permission);
        return snapshot;
      },
      inspect: async (topic) => {
        const store = await SqliteSessionStore.open(current.root, {
          readOnlySnapshot: true,
          directory: options.stateDirectory,
        });
        try {
          const session =
            activeHarness?.runtime.currentSession ??
            (sessionId ? await store.get(sessionId) : undefined);
          return await inspectWorkspace(current.root, topic, session, {
            directory: options.stateDirectory,
          });
        } finally {
          store.close();
        }
      },
      readArtifact: async (id) => {
        const store = await SqliteSessionStore.open(current.root, {
          readOnlySnapshot: true,
          directory: options.stateDirectory,
        });
        try {
          return await store.readArtifact(id);
        } finally {
          store.close();
        }
      },
      mode,
      changeMode: (next) => {
        mode = next;
      },
      rewind: (id, approve) =>
        rewindCheckpoint(
          current.root,
          id,
          mode === "plan" ? "read-only" : settings.currentConfig().permission,
          approve,
        ),
      decidePlan: async (approved) => {
        if (!sessionId) throw new Error("Select a conversation with a draft plan first.");
        const session = await decidePlan(current.root, sessionId, approved, options);
        mode = session.mode ?? "plan";
        return session;
      },
      sessions: createWorkspaceHistory(
        current.root,
        (selected) => {
          sessionId = selected;
        },
        { directory: options.stateDirectory },
      ),
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
          {
            ...settings.harnessOptions(),
            mode,
            policyPath: options.policyPath,
            stateDirectory: options.stateDirectory,
            resumeId: sessionId,
          },
        );
        activeHarness = harness;
        // A settings write can finish while the harness is still being initialized.
        harness.setPermission(settings.currentConfig().permission);
        try {
          const session = await harness.run(prompt, signal, sessionId);
          sessionId = session.id;
          return session;
        } finally {
          // Keep failed or interrupted turns available to the next prompt, too.
          sessionId = harness.runtime.currentSession?.id ?? sessionId;
          activeHarness = undefined;
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
