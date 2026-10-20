import {
  createRunPlan,
  boundText,
  startPlanTask,
  verifyPlanTask,
  type RunPlanInput,
  type RunPlanState,
  type RuntimeEvent,
  type Session,
  type ToolDefinition,
} from "@vcli/core";
import { syncPlanChat } from "../workflows/plans.ts";
import { objectSchema } from "./schema.ts";

interface PlanController {
  getSession(): Session | undefined;
  save(session: Session): Promise<void>;
  emit?(event: RuntimeEvent): void | Promise<void>;
  hasTool?(name: string): boolean;
}

const shortText = { type: "string", minLength: 1, maxLength: 1000 };
const taskId = { type: "string", minLength: 1, maxLength: 80, pattern: "^[\\w.-]+$" };
const notes = {
  type: "array",
  maxItems: 20,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 500 },
};

/** Plan metadata uses the existing run state; publishing never grants source/tool permissions. */
export function createPlanTools(controller: PlanController): ToolDefinition[] {
  function session(id: string): Session {
    const value = controller.getSession();
    if (!value || value.id !== id) throw new Error("No matching active run.");
    return value;
  }
  async function save(value: Session, plan: RunPlanState) {
    const next = { ...value, plan, chat: value.chat?.map((message) => ({ ...message })) };
    const { messageId, text } = syncPlanChat(next);
    await controller.save(next);
    value.plan = next.plan;
    value.chat = next.chat;
    await controller.emit?.({
      type: "plan",
      sessionId: value.id,
      time: new Date().toISOString(),
      data: { plan, text, messageId, createdAt: plan.createdAt },
    });
  }
  return [
    {
      name: "plan_publish",
      kind: "read",
      eager: false,
      description:
        "Save a structured implementation plan in this run and show it in chat. Include ordered tasks, dependencies, tools, verification tool, risks, assumptions and completion criteria. Plan mode awaits explicit human approval; build mode retains current permissions.",
      inputSchema: objectSchema(
        {
          goal: shortText,
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: objectSchema(
              {
                id: taskId,
                description: shortText,
                dependencies: { type: "array", uniqueItems: true, maxItems: 50, items: taskId },
                tools: notes,
                doneWhen: shortText,
                verificationTool: { type: "string", minLength: 1, maxLength: 100 },
              },
              ["id", "description", "dependencies", "tools", "doneWhen", "verificationTool"],
            ),
          },
          risks: notes,
          assumptions: notes,
          doneWhen: shortText,
        },
        ["goal", "steps", "risks", "assumptions", "doneWhen"],
      ),
      async execute(args, context) {
        const value = session(context.sessionId);
        if (value.plan?.steps.some((step) => step.evidence.length && step.status !== "complete"))
          throw new Error("Finish the active plan before replacing tasks with recorded work.");
        const input = args as unknown as RunPlanInput;
        if (controller.hasTool)
          for (const step of input.steps)
            for (const name of step.tools)
              if (!controller.hasTool(name)) throw new Error(`Unknown planned tool: ${name}`);
        const plan = createRunPlan(input, value.mode ?? "build");
        await save(value, plan);
        return {
          text:
            plan.status === "draft"
              ? "Structured plan saved; waiting for explicit approval. /build approves; /plan reject rejects."
              : `Structured plan saved. ${plan.steps.length} tasks; runtime verifies completion.`,
          details: { plan },
        };
      },
    },
    {
      name: "plan_task",
      kind: "read",
      eager: false,
      description:
        "Inspect plan status, start a ready task or verify it with successful evidenceCallIds recorded for that task. Dependencies must be complete. A text claim or failed tool cannot complete a task; its verificationTool must succeed. Starting selects task attribution for subsequent calls.",
      inputSchema: {
        ...objectSchema(
          {
            action: { type: "string", enum: ["status", "start", "verify"] },
            taskId,
            evidenceCallIds: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              maxItems: 50,
              items: { type: "string", minLength: 1 },
            },
          },
          ["action"],
        ),
        allOf: [
          {
            if: { properties: { action: { enum: ["start", "verify"] } } },
            then: { required: ["taskId"] },
          },
          {
            if: { properties: { action: { const: "verify" } } },
            then: { required: ["evidenceCallIds"] },
          },
        ],
      },
      async execute(args, context) {
        const value = session(context.sessionId);
        if (!value.plan) throw new Error("Publish a plan first with plan_publish.");
        if (args.action === "status") {
          const selected = args.taskId
            ? value.plan.steps.find((step) => step.id === args.taskId)
            : value.plan;
          if (!selected) throw new Error(`Unknown plan task: ${args.taskId}`);
          const fullOutput = JSON.stringify(selected, null, 2);
          return { text: boundText(fullOutput, 1200), fullOutput, details: { plan: value.plan } };
        }
        const plan = structuredClone(value.plan);
        const id = args.taskId as string;
        const task =
          args.action === "start"
            ? startPlanTask(plan, id)
            : verifyPlanTask(plan, id, args.evidenceCallIds as string[]);
        await save(value, plan);
        return { text: `Task ${task.id}: ${task.status}. ${task.doneWhen}`, details: { task } };
      },
    },
  ];
}
