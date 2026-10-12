import { createCliRenderer } from "@opentui/core";
import type { WorkspaceOptions } from "./contracts.ts";
export { WorkspaceSettingsError } from "./contracts.ts";
export type {
  WorkspaceOptions,
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
  WorkspaceProvider,
  WorkspaceSessionInfo,
  WorkspaceSessions,
} from "./contracts.ts";

export async function startWorkspace(options: WorkspaceOptions): Promise<void> {
  // Install the client resolver before loading Solid or JSX from another project's cwd.
  await import("@opentui/solid/preload");
  const [{ render }, { createComponent }, { Workspace }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js"),
    import("./workspace.tsx"),
  ]);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 20,
    maxFps: 30,
    screenMode: "alternate-screen",
    consoleMode: "disabled",
    kittyImageTransport: "raw",
  });
  const done = new Promise<void>((resolve) => renderer.once("destroy", resolve));
  try {
    await render(() => createComponent(Workspace, options), renderer);
    await done;
  } finally {
    renderer.destroy();
  }
}
