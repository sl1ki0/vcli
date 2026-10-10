import type { ArchitectureGraph, ArchitectureService } from "@vcli/core";
import type { Config } from "./config.ts";
import { createHarness } from "./harness.ts";
// Static linking initializes OpenTUI's async module graph in compiled Bun clients.
import { startWorkspace } from "@vcli/tui";
import { print, printTree } from "./io.ts";
export async function interactive(
  root: string,
  config: Config,
  architecture: ArchitectureService,
  graph: ArchitectureGraph,
) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    print(printTree(graph));
    return;
  }
  let sessionId: string | undefined;
  await startWorkspace({
    root,
    graph,
    architecture,
    permission: config.permission,
    renderer: config.renderer,
    run: async (prompt, signal, emit, approve) => {
      const harness = await createHarness(root, config, architecture, emit, approve);
      try {
        const session = await harness.run(prompt, signal, sessionId);
        sessionId = session.id;
        return session;
      } finally {
        await harness.close();
      }
    },
  });
}
