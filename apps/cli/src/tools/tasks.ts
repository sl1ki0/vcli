import { boundText, type ToolDefinition } from "@vcli/core";
import { LocalTaskStore, type TaskChange } from "../workflows/tasks.ts";
import { objectSchema, stringSchema } from "./schema.ts";

export function createTaskTools(store: LocalTaskStore): ToolDefinition[] {
  return [
    {
      name: "tasks_list",
      kind: "read",
      eager: false,
      description:
        "List persistent project tasks, progress and blocking dependencies across sessions.",
      inputSchema: objectSchema({}, []),
      async execute() {
        const tasks = await store.list();
        const fullOutput = JSON.stringify(tasks, null, 2);
        return { text: boundText(fullOutput, 2500), fullOutput, details: { tasks } };
      },
    },
    {
      name: "tasks_update",
      kind: "write",
      eager: false,
      description:
        "Create or update a project task. Omit id to create; title required. Track dependencies by task ID; start/complete only after dependencies complete. Never mark unverified work complete.",
      inputSchema: objectSchema(
        {
          id: stringSchema,
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 8000 },
          status: { type: "string", enum: ["pending", "in-progress", "complete", "canceled"] },
          dependencies: { type: "array", items: stringSchema, uniqueItems: true, maxItems: 1000 },
        },
        [],
      ),
      async execute(args, context) {
        const change = args as TaskChange;
        if (!args.id && !change.title) throw new Error("Creating a task requires a title.");
        const task = args.id
          ? await store.update(String(args.id), change, context.signal)
          : await store.create(
              { ...change, title: change.title! },
              context.sessionId,
              context.signal,
            );
        return { text: JSON.stringify(task), details: { task } };
      },
    },
  ];
}
