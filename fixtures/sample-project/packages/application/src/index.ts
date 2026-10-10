import { newTask } from "@sample/domain";
import { saveTask } from "@sample/storage";

let nextId = 0;

export function createTask(title: string) {
  return saveTask(newTask(String(++nextId), title));
}
