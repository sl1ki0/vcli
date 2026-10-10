import { createTask } from "@sample/application";

export function handleCreate(title: string) {
  return { status: 201, body: createTask(title) };
}
