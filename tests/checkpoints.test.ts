import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGate, ToolRegistry, type ToolCall, type ToolContext } from "@vcli/core";
import { fileTools } from "../apps/cli/src/tools/files.ts";
import { createCheckpointTools } from "../apps/cli/src/tools/checkpoints.ts";
import { CheckpointService } from "../apps/cli/src/workflows/checkpoints.ts";
import { ProjectPolicy } from "../apps/cli/src/workflows/policy.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vcli-checkpoint-"));
  roots.push(root);
  const service = new CheckpointService(root);
  const context: ToolContext = {
    root,
    sessionId: "session-a",
    signal: new AbortController().signal,
  };
  const call = (path: string, newText: string): ToolCall => ({
    id: crypto.randomUUID(),
    name: "files_patch",
    arguments: { path, newText, overwrite: true },
  });
  const edit = async (path: string, newText: string) => {
    const request = call(path, newText);
    const id = (await service.before(request, context))!;
    const result = await fileTools
      .find((tool) => tool.name === request.name)!
      .execute(request.arguments, context);
    await service.after(id, result);
    return id;
  };
  return { root, service, context, call, edit };
}

describe("exact-file checkpoints", () => {
  test("restores original binary bytes and executable permissions after restart", async () => {
    const f = await fixture();
    const original = Buffer.from([0, 255, 254, 127, 10]);
    await writeFile(join(f.root, "module"), original);
    await chmod(join(f.root, "module"), 0o751);
    const id = await f.edit("module", "replacement");
    const restarted = new CheckpointService(f.root);
    expect((await restarted.list())[0]).toMatchObject({ id, path: "module", status: "ready" });
    expect(await restarted.restore(id, f.context)).toMatchObject({ changedPaths: ["module"] });
    expect(await readFile(join(f.root, "module"))).toEqual(original);
    expect((await stat(join(f.root, "module"))).mode & 0o777).toBe(0o751);
    expect((await restarted.list())[0]!.status).toBe("restored");
    await expect(restarted.restore(id, f.context)).rejects.toThrow("Only completed");
  });

  test("deletes only the new file and preserves neighboring content", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src", "other.ts"), "external");
    const id = await f.edit("src/new.ts", "export {};");
    await f.service.restore(id, f.context);
    expect(await Bun.file(join(f.root, "src/new.ts")).exists()).toBe(false);
    expect(await readFile(join(f.root, "src/other.ts"), "utf8")).toBe("external");
  });

  test("restores empty existing files, exact source span edits, and absolute project paths", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "empty"), "");
    const empty = await f.edit(join(f.root, "empty"), "now populated");
    await f.service.restore(empty, f.context);
    expect(await readFile(join(f.root, "empty"), "utf8")).toBe("");
    await writeFile(join(f.root, "span"), "before target after");
    const call = {
      ...f.call("span", "new"),
      arguments: { path: "span", oldText: "target", newText: "new" },
    };
    const id = (await f.service.before(call, f.context))!;
    const result = await fileTools
      .find((tool) => tool.name === "files_patch")!
      .execute(call.arguments, f.context);
    await f.service.after(id, result);
    expect(await readFile(join(f.root, "span"), "utf8")).toBe("before new after");
    await f.service.restore(id, f.context);
    expect(await readFile(join(f.root, "span"), "utf8")).toBe("before target after");
  });

  test("cancellation cannot start capture or restore", async () => {
    const f = await fixture();
    const context = { ...f.context, signal: AbortSignal.abort() };
    await expect(f.service.before(f.call("file", "new"), context)).rejects.toThrow();
    expect(await f.service.list()).toEqual([]);
    const id = await f.edit("file", "new");
    await expect(f.service.restore(id, context)).rejects.toThrow();
    expect(await readFile(join(f.root, "file"), "utf8")).toBe("new");
    expect((await f.service.list())[0]!.status).toBe("ready");
  });

  test("refuses content and permission edits made outside the agent", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "file"), "before");
    const id = await f.edit("file", "after");
    await writeFile(join(f.root, "file"), "user edit");
    await expect(f.service.restore(id, f.context)).rejects.toThrow("preserve external edits");
    expect(await readFile(join(f.root, "file"), "utf8")).toBe("user edit");
    await writeFile(join(f.root, "file"), "after");
    await chmod(join(f.root, "file"), 0o700);
    await expect(f.service.restore(id, f.context)).rejects.toThrow("preserve external edits");
  });

  test("requires reverse edit order and keeps unrelated files intact", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "file"), "initial");
    const first = await f.edit("file", "first");
    const second = await f.edit("file", "second");
    await expect(f.service.restore(first, f.context)).rejects.toThrow("preserve external edits");
    await f.service.restore(second, f.context);
    await f.service.restore(first, f.context);
    expect(await readFile(join(f.root, "file"), "utf8")).toBe("initial");
  });

  test("never rewinds pending, failed, or mismatched mutation outcomes", async () => {
    const f = await fixture();
    const pending = (await f.service.before(f.call("pending", "expected"), f.context))!;
    await expect(f.service.restore(pending, f.context)).rejects.toThrow("Only completed");
    await f.service.after(pending);
    expect((await f.service.list())[0]!.status).toBe("uncertain");
    await expect(f.service.restore(pending, f.context)).rejects.toThrow("Only completed");
    const changed = (await f.service.before(f.call("mismatch", "expected"), f.context))!;
    await writeFile(join(f.root, "mismatch"), "external edit");
    await f.service.after(changed, { text: "Updated" });
    await expect(f.service.restore(changed, f.context)).rejects.toThrow("Only completed");
    expect(await readFile(join(f.root, "mismatch"), "utf8")).toBe("external edit");
  });

  test("rejects symlink files, symlink ancestors, hard links, and outside paths", async () => {
    const f = await fixture();
    const outside = await fixture();
    await writeFile(join(outside.root, "target"), "external");
    await symlink(join(outside.root, "target"), join(f.root, "link"));
    await symlink(outside.root, join(f.root, "directory"));
    await link(join(outside.root, "target"), join(f.root, "hard-link"));
    for (const path of ["link", "directory/target", "hard-link", join(outside.root, "target")]) {
      await expect(f.service.before(f.call(path, "overwrite"), f.context)).rejects.toThrow();
    }
    expect(await readFile(join(outside.root, "target"), "utf8")).toBe("external");
    await symlink(outside.root, join(f.root, ".vcli"));
    await expect(f.service.before(f.call("safe", "text"), f.context)).rejects.toThrow(
      "symbolic link",
    );
  });

  test("refuses replacement symlinks during restoration and corrupt backups", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "file"), "before");
    const id = await f.edit("file", "after");
    await rm(join(f.root, "file"));
    await writeFile(join(f.root, "other"), "external");
    await symlink(join(f.root, "other"), join(f.root, "file"));
    await expect(f.service.restore(id, f.context)).rejects.toThrow("symbolic link");
    expect(await readFile(join(f.root, "other"), "utf8")).toBe("external");
    await rm(join(f.root, "file"));
    await writeFile(join(f.root, "file"), "after");
    await writeFile(join(f.root, ".vcli/state/checkpoints", `${id}.before`), "corrupt");
    await expect(f.service.restore(id, f.context)).rejects.toThrow("corrupt");
    expect(await readFile(join(f.root, "file"), "utf8")).toBe("after");
  });

  test("restore revalidates current directory policy before any replacement", async () => {
    const f = await fixture();
    const outside = await fixture();
    await mkdir(join(f.root, "private"));
    await writeFile(join(f.root, "private/file"), "before");
    const id = await f.edit("private/file", "after");
    const policyPath = join(outside.root, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        commands: { allow: [], deny: [] },
        directories: { allow: ["."], deny: ["private"] },
      }),
    );
    const policy = await ProjectPolicy.load(f.root, await realpath(policyPath));
    await expect(
      f.service.restore(id, {
        ...f.context,
        authorizePath: (path, write) => policy.resolvePath(path, { write }),
      }),
    ).rejects.toThrow("Directory");
    expect(await readFile(join(f.root, "private/file"), "utf8")).toBe("after");
  });

  test("forged checkpoint metadata cannot restore protected configuration", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "source"), "before");
    const id = await f.edit("source", "after");
    const metadataPath = join(f.root, ".vcli/state/checkpoints", `${id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.path = ".vcli/private-fixture.txt";
    await writeFile(join(f.root, ".vcli/private-fixture.txt"), "after");
    await writeFile(metadataPath, JSON.stringify(metadata));
    await expect(f.service.restore(id, f.context)).rejects.toThrow("protected");
    expect(await readFile(join(f.root, ".vcli/private-fixture.txt"), "utf8")).toBe("after");
  });

  test("oversized source reads and checkpoints fail before buffering the whole file", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "huge.txt"), "");
    await truncate(join(f.root, "huge.txt"), 16 * 1024 * 1024 + 1);
    await expect(
      fileTools
        .find((tool) => tool.name === "files_read")!
        .execute({ path: "huge.txt", start: 1, end: 1 }, f.context),
    ).rejects.toThrow("byte limit");
    await expect(f.service.before(f.call("huge.txt", "new"), f.context)).rejects.toThrow(
      "byte limit",
    );
    expect((await stat(join(f.root, "huge.txt"))).size).toBe(16 * 1024 * 1024 + 1);
  });

  test("leaves denied, invalid, and shell calls without captured mutations", async () => {
    const f = await fixture();
    expect(
      await f.service.before({ id: "shell", name: "shell", arguments: {} }, f.context),
    ).toBeUndefined();
    await expect(
      f.service.before(
        {
          ...f.call("bad", "text"),
          arguments: { path: "bad", oldText: "missing", newText: "new" },
        },
        f.context,
      ),
    ).rejects.toThrow("match exactly once");
    expect(await f.service.list()).toEqual([]);
    const tools = createCheckpointTools(f.service);
    const registry = new ToolRegistry();
    tools.forEach((tool) => registry.register(tool));
    expect(registry.schemas(4000)).toEqual([]);
    registry.activate(tools.map((tool) => tool.name));
    expect(registry.schemas(4000)).toHaveLength(2);
    await expect(
      new PermissionGate("read-only").authorize(tools[1]!, { id: "anything" }),
    ).rejects.toThrow("denies");
    const id = await f.edit("new", "value");
    const result = await tools[0]!.execute({}, { ...f.context, sessionId: "different" });
    expect(result.text).toBe("[]");
    expect((await tools[0]!.execute({}, f.context)).text).toContain(id);
  });
});
