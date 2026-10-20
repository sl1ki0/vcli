import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunPlanState, Session } from "@vcli/core";

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
  const directory = join(options.directory ?? join(root, ".vcli/state"), "plans");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${session.id}.md`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temporary,
    session.plan ? formatRunPlan(session.plan, session.id) : response!.text,
    {
      mode: 0o600,
    },
  );
  await rename(temporary, path);
  if (session.plan) {
    const structured = join(directory, `${session.id}.json`);
    const pending = `${structured}.${crypto.randomUUID()}.tmp`;
    await writeFile(pending, JSON.stringify({ runId: session.id, plan: session.plan }, null, 2), {
      mode: 0o600,
    });
    await rename(pending, structured);
  }
}

export async function readPlans(
  root: string,
  runId?: string,
  options: { directory?: string } = {},
): Promise<string> {
  if (runId && !/^[\w.-]+$/.test(runId)) throw new Error("Invalid plan run ID.");
  const directory = join(options.directory ?? join(root, ".vcli/state"), "plans");
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const plans = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md") && (!runId || name === `${runId}.md`))
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
