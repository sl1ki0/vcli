import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

export type TaskStatus = "pending" | "in-progress" | "complete" | "canceled";
export interface LocalTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}
export interface TaskChange {
  title?: string;
  description?: string;
  status?: TaskStatus;
  dependencies?: string[];
}

const statuses: TaskStatus[] = ["pending", "in-progress", "complete", "canceled"];

function validate(tasks: LocalTask[]): void {
  if (tasks.length > 1000)
    throw new Error("Task limit reached (1,000). Archive tasks before adding more.");
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Duplicate task IDs.");
  for (const task of tasks) {
    if (!task.id || typeof task.title !== "string" || !task.title.trim() || task.title.length > 200)
      throw new Error("Task title must contain 1–200 characters.");
    if (typeof task.description !== "string" || task.description.length > 8000)
      throw new Error("Task description must be at most 8,000 characters.");
    if (!statuses.includes(task.status) || !Array.isArray(task.dependencies))
      throw new Error("Invalid task status or dependencies.");
    if (new Set(task.dependencies).size !== task.dependencies.length)
      throw new Error("Duplicate task dependencies.");
    if (task.dependencies.some((id) => !ids.has(id))) throw new Error("Unknown task dependency.");
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error("Task dependencies contain a cycle.");
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  for (const task of tasks)
    if (
      (task.status === "in-progress" || task.status === "complete") &&
      task.dependencies.some((id) => byId.get(id)!.status !== "complete")
    )
      throw new Error(`Task ${task.id} is blocked by unfinished dependencies.`);
}

/** Project-local tasks survive sessions; atomic writes and an exclusive lock prevent lost updates. */
export class LocalTaskStore {
  private readonly path: string;
  constructor(root: string) {
    this.path = join(root, ".vcli", "state", "tasks.json");
  }

  async list(): Promise<LocalTask[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.tasks))
      throw new Error("Unsupported task document.");
    validate(data.tasks);
    return data.tasks;
  }

  async create(
    change: TaskChange & { title: string },
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<LocalTask> {
    return this.mutate((tasks) => {
      const now = new Date().toISOString();
      const task: LocalTask = {
        id: randomUUID(),
        title: change.title.trim(),
        description: change.description ?? "",
        status: change.status ?? "pending",
        dependencies: change.dependencies ?? [],
        sessionId,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task);
      return task;
    }, signal);
  }

  async update(id: string, change: TaskChange, signal?: AbortSignal): Promise<LocalTask> {
    return this.mutate((tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new Error(`Task not found: ${id}`);
      for (const key of ["title", "description", "status", "dependencies"] as const) {
        const value = change[key];
        if (value !== undefined) Object.assign(task, { [key]: value });
      }
      task.updatedAt = new Date().toISOString();
      return task;
    }, signal);
  }

  private async mutate(
    change: (tasks: LocalTask[]) => LocalTask,
    signal?: AbortSignal,
  ): Promise<LocalTask> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 3000;
    let lock;
    while (!lock) {
      signal?.throwIfAborted();
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Tasks are locked by another process. If no vcli process is running, remove ${lockPath}.`,
          );
        await setTimeout(25, undefined, { signal });
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const tasks = await this.list();
      const task = change(tasks);
      validate(tasks);
      signal?.throwIfAborted();
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, tasks }, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      return task;
    } finally {
      await rm(temporary, { force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
