import type { WorkspaceSessions } from "@vcli/tui";
import { SqliteSessionStore } from "./store.ts";

/** History navigation is entirely local and never constructs a provider harness. */
export function createWorkspaceHistory(
  root: string,
  select: (sessionId?: string) => void,
  options: { directory?: string } = {},
): WorkspaceSessions {
  return {
    list: async () => {
      const store = await SqliteSessionStore.open(root, options);
      try {
        return await store.summaries(root);
      } finally {
        store.close();
      }
    },
    open: async (id) => {
      const store = await SqliteSessionStore.open(root, options);
      try {
        const session = await store.get(id);
        if (!session) throw new Error("That conversation could not be found.");
        if (session.root !== root) throw new Error("That conversation belongs to another project.");
        select(session.id);
        return session;
      } finally {
        store.close();
      }
    },
    create: () => select(undefined),
  };
}
