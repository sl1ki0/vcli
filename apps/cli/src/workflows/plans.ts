import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "@vcli/core";

/** Plans are local artifacts; completing a plan never enables implementation automatically. */
export async function savePlan(root: string, session: Session): Promise<void> {
  if (session.mode !== "plan" || session.status !== "complete") return;
  const response = session.chat
    ?.filter((message) => message.role === "assistant" && message.text.trim())
    .at(-1);
  if (!response) return;
  const directory = join(root, ".vcli/state/plans");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${session.id}.md`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, response.text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readPlans(root: string): Promise<string> {
  const directory = join(root, ".vcli/state/plans");
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const plans = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md"))
      .sort()
      .slice(-20)
      .map(
        async (name) =>
          `Plan ${name.slice(0, -3)}\n${await readFile(join(directory, name), "utf8")}`,
      ),
  );
  return (
    plans.join("\n\n") ||
    "No plans yet. Use /plan, then describe the change. /build enables implementation."
  );
}
