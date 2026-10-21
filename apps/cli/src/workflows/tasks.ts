import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { storageFilesystem, storagePath } from "./state-path.ts";
import type { RootedFileSystem } from "./rooted-filesystem.ts";

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
  constructor(private readonly root: string) {}

  private path(name = "tasks.json"): Promise<string> {
    return storagePath(this.root, ["state", name]);
  }

  async list(): Promise<LocalTask[]> {
    const path = await this.path();
    let filesystem: RootedFileSystem;
    try {
      filesystem = storageFilesystem(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    using ownedFilesystem = filesystem;
    return this.readTasks(ownedFilesystem);
  }

  private readTasks(filesystem: RootedFileSystem): LocalTask[] {
    let raw: string;
    try {
      raw = filesystem.readText("tasks.json", 32 * 1024 * 1024);
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
    using filesystem = storageFilesystem(await storagePath(this.root, ["state"]), true);
    await this.path();
    const lockName = "tasks.json.lock";
    const deadline = Date.now() + 3000;
    const lockToken = randomUUID();
    const lockDigest = createHash("sha256").update(lockToken).digest("hex");
    let lock = false;
    while (!lock) {
      signal?.throwIfAborted();
      const lockPath = await this.path(lockName);
      try {
        filesystem.writeAtomic(lockName, lockToken, { expected: null, mode: 0o600 });
        lock = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Tasks are locked by another process. If no vcli process is running, remove ${lockPath}.`,
          );
        await setTimeout(25, undefined, { signal });
      }
    }
    try {
      const tasks = this.readTasks(filesystem);
      const task = change(tasks);
      validate(tasks);
      signal?.throwIfAborted();
      filesystem.writeAtomic("tasks.json", JSON.stringify({ version: 1, tasks }, null, 2), {
        mode: 0o600,
      });
      return task;
    } finally {
      filesystem.delete(lockName, { expected: { digest: lockDigest, mode: 0o600 } });
    }
  }
}
