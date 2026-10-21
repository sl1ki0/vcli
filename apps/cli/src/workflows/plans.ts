import type { RunPlanState, Session } from "@vcli/core";
import { storageFilesystem, storagePath } from "./state-path.ts";

const statusLabel = { pending: "○", "in-progress": "◐", complete: "✓" } as const;

/** Human presentation is stored in chat/artifacts, never injected as duplicate model context. */
export function formatRunPlan(plan: RunPlanState, runId: string): string {
  const progress = plan.steps.filter((task) => task.status === "complete").length;
  return [
    `## Execution plan · ${plan.status}`,
    plan.goal,
    `Run: \`${runId}\` · ${progress}/${plan.steps.length} verified tasks`,
    ...plan.steps.map(
      (task, index) =>
        `### ${index + 1}. ${statusLabel[task.status]} ${task.description}\n` +
        `ID: \`${task.id}\` · ${task.status}\n` +
        `Dependencies: ${task.dependencies.join(", ") || "none"}\n` +
        `Tools: ${task.tools.join(", ")}\n` +
        `Ready when: ${task.doneWhen}\n` +
        `Verification: \`${task.verificationTool}\`${task.verifiedBy?.length ? ` · recorded calls: ${task.verifiedBy.join(", ")}` : ""}`,
    ),
    `**Risks:** ${plan.risks.join("; ") || "none identified"}`,
    `**Assumptions:** ${plan.assumptions.join("; ") || "none"}`,
    `**Done when:** ${plan.doneWhen}`,
    plan.status === "draft"
      ? "**Awaiting your decision.** `/build` or `/plan approve` approves this plan; `/plan reject` rejects it. `/plan visual` opens dependencies."
      : "Use `/plan visual` to open dependencies. Plan approval retains the active tool permission mode.",
  ].join("\n\n");
}

export function syncPlanChat(session: Session): { messageId: string; text: string } {
  const plan = session.plan;
  if (!plan) throw new Error("No structured plan is saved for this run.");
  const messageId = `plan:${session.id}:${plan.createdAt}`;
  const text = formatRunPlan(plan, session.id);
  session.chat ??= [];
  const existing = session.chat.find((message) => message.id === messageId);
  if (existing) existing.text = text;
  else
    session.chat.push({
      id: messageId,
      role: "assistant",
      text,
      createdAt: plan.createdAt,
      status: "complete",
    });
  return { messageId, text };
}

/** Plans are local artifacts; completing a plan never enables implementation automatically. */
export async function savePlan(
  root: string,
  session: Session,
  options: { directory?: string } = {},
): Promise<void> {
  if (
    !session.plan &&
    (session.mode !== "plan" || !["complete", "awaiting-plan"].includes(session.status))
  )
    return;
  const response = session.chat
    ?.filter((message) => message.role === "assistant" && message.text.trim())
    .at(-1);
  if (!session.plan && !response) return;
  if (!/^[\w.-]+$/.test(session.id)) throw new Error("Invalid plan run ID.");
  const parts = options.directory ? ["plans"] : ["state", "plans"];
  const path = (name?: string) =>
    storagePath(root, name ? [...parts, name] : parts, options.directory);
  using filesystem = storageFilesystem(await path(), true);
  await path(`${session.id}.md`);
  if (session.plan) await path(`${session.id}.json`);
  const write = async (name: string, content: string) => {
    await path(name);
    filesystem.writeAtomic(name, content, { mode: 0o600 });
  };
  await write(
    `${session.id}.md`,
    session.plan ? formatRunPlan(session.plan, session.id) : response!.text,
  );
  if (session.plan) {
    await write(
      `${session.id}.json`,
      JSON.stringify({ runId: session.id, plan: session.plan }, null, 2),
    );
  }
}

export async function readPlans(
  root: string,
  runId?: string,
  options: { directory?: string } = {},
): Promise<string> {
  if (runId && !/^[\w.-]+$/.test(runId)) throw new Error("Invalid plan run ID.");
  const parts = options.directory ? ["plans"] : ["state", "plans"];
  const directory = await storagePath(root, parts, options.directory);
  let filesystem: ReturnType<typeof storageFilesystem>;
  try {
    filesystem = storageFilesystem(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "No plans yet. Use /plan, then describe the change. /build enables implementation.";
    throw error;
  }
  using ownedFilesystem = filesystem;
  const entries = ownedFilesystem.list().map((entry) => entry.name);
  const plans = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md") && (!runId || name === `${runId}.md`))
      .sort()
      .slice(-20)
      .map(async (name) => {
        try {
          return `Plan ${name.slice(0, -3)}\n${ownedFilesystem.readText(name, 32 * 1024 * 1024)}`;
        } catch (error) {
          throw new Error(
            `Storage plan file refused: ${error instanceof Error ? error.message : "unreadable file"}`,
          );
        }
      }),
  );
  return (
    plans.join("\n\n") ||
    "No plans yet. Use /plan, then describe the change. /build enables implementation."
  );
}
