import type { Task } from "@sample/domain";

const tasks = new Map<string, Task>();

export function saveTask(task: Task): Task {
  tasks.set(task.id, task);
  return task;
}

export function findTask(id: string): Task | undefined {
  return tasks.get(id);
}
