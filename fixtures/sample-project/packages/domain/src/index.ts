export interface Task {
  id: string;
  title: string;
  completed: boolean;
}

export function newTask(id: string, title: string): Task {
  if (!title.trim()) throw new Error("A task needs a title");
  return { id, title: title.trim(), completed: false };
}
