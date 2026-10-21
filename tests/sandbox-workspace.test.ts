import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxWorkspace } from "../apps/cli/src/workflows/sandbox-workspace.ts";

const roots: string[] = [];
const workspaces: Awaited<ReturnType<typeof createSandboxWorkspace>>[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vcli-workspace-test-"));
  roots.push(root);
  return root;
}
async function stage(
  root: string,
  options: Partial<Parameters<typeof createSandboxWorkspace>[0]> = {},
) {
  const workspace = await createSandboxWorkspace({ root, access: "write", ...options });
  workspaces.push(workspace);
  return workspace;
}
const absent = (path: string) => expect(access(path)).rejects.toThrow();

describe("disposable process workspaces", () => {
  test("copies regular allowed sources and empty directories, omitting private state and generated trees", async () => {
    const root = await fixture();
    await mkdir(join(root, "src", "empty"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".vcli"));
    await mkdir(join(root, ".kube"));
    await writeFile(join(root, "src", "source.ts"), "allowed");
    await writeFile(join(root, ".env"), "PRIVATE");
    await writeFile(join(root, ".vcli", "config.json"), "PRIVATE");
    await writeFile(join(root, ".kube", "config"), "PRIVATE");
    await writeFile(join(root, "node_modules", "source.js"), "dependency");
    const workspace = await stage(root);
    expect(await readFile(join(workspace.root, "src", "source.ts"), "utf8")).toBe("allowed");
    await access(join(workspace.root, "src", "empty"));
    await absent(join(workspace.root, ".env"));
    await absent(join(workspace.root, ".vcli", "config.json"));
    await absent(join(workspace.root, ".kube"));
    await absent(join(workspace.root, "node_modules"));
    expect(workspace.mapPath(join(await realpath(root), "src"))).toBe(
      workspace.cwd(join(root, "src")),
    );
  });

  test("imports a finished edit/create/delete and empty-directory change exactly once", async () => {
    const root = await fixture();
    await writeFile(join(root, "edited"), "before");
    await writeFile(join(root, "deleted"), "before");
    await mkdir(join(root, "removed-empty"));
    const workspace = await stage(root);
    await writeFile(join(workspace.root, "edited"), "after");
    await writeFile(join(workspace.root, "created"), "new");
    await rm(join(workspace.root, "deleted"));
    await rm(join(workspace.root, "removed-empty"), { recursive: true });
    await mkdir(join(workspace.root, "created-empty"));
    await workspace.commit();
    await workspace.commit();
    expect(await readFile(join(root, "edited"), "utf8")).toBe("after");
    expect(await readFile(join(root, "created"), "utf8")).toBe("new");
    await absent(join(root, "deleted"));
    await absent(join(root, "removed-empty"));
    await access(join(root, "created-empty"));
  });

  test("validates every touched file before importing any change", async () => {
    const root = await fixture();
    await writeFile(join(root, "a"), "original-a");
    await writeFile(join(root, "z"), "original-z");
    const workspace = await stage(root);
    await writeFile(join(workspace.root, "a"), "sandbox-a");
    await writeFile(join(workspace.root, "z"), "sandbox-z");
    await writeFile(join(root, "z"), "human-z");
    await expect(workspace.commit()).rejects.toThrow("No changes were imported");
    expect(await readFile(join(root, "a"), "utf8")).toBe("original-a");
    expect(await readFile(join(root, "z"), "utf8")).toBe("human-z");
  });

  test("refuses unexpected children in a removed directory before deleting its original files", async () => {
    const root = await fixture();
    await mkdir(join(root, "removed"));
    await writeFile(join(root, "removed", "source"), "original");
    const workspace = await stage(root);
    await rm(join(workspace.root, "removed"), { recursive: true });
    await writeFile(join(root, "removed", "human"), "external");
    await expect(workspace.commit()).rejects.toThrow("directory changed");
    expect(await readFile(join(root, "removed", "source"), "utf8")).toBe("original");
    expect(await readFile(join(root, "removed", "human"), "utf8")).toBe("external");
  });

  test("does not follow host symlinks, rejects host hard links, and rejects linked process outputs before any import", async () => {
    const root = await fixture();
    const outside = await fixture();
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "HOST");
    await symlink(sentinel, join(root, "linked-source"));
    const workspace = await stage(root);
    await absent(join(workspace.root, "linked-source"));
    await writeFile(join(workspace.root, "a-valid-change"), "new");
    await symlink(sentinel, join(workspace.root, "z-output-link"));
    await expect(workspace.commit()).rejects.toThrow("unsupported link");
    await absent(join(root, "a-valid-change"));
    expect(await readFile(sentinel, "utf8")).toBe("HOST");
    await link(sentinel, join(root, "host-hardlink"));
    await expect(stage(root)).rejects.toThrow("hard links");
  });

  test("does not import process-created credentials or private configuration", async () => {
    const root = await fixture();
    const workspace = await stage(root);
    await writeFile(join(workspace.root, ".env.local"), "secret");
    await mkdir(join(workspace.root, ".docker"));
    await writeFile(join(workspace.root, ".docker", "config.json"), "secret");
    await workspace.commit();
    await absent(join(root, ".env.local"));
    await absent(join(root, ".docker"));
  });

  test("revalidates imported paths against policy and refuses read-only mutations", async () => {
    const root = await fixture();
    await writeFile(join(root, "source"), "original");
    const workspace = await stage(root, {
      authorizePath: async (path, write) => {
        if (write) throw new Error("policy denied");
        return path;
      },
    });
    await writeFile(join(workspace.root, "source"), "changed");
    await expect(workspace.commit()).rejects.toThrow("policy denied");
    expect(await readFile(join(root, "source"), "utf8")).toBe("original");
    const readonly = await stage(root, { access: "read" });
    await writeFile(join(readonly.root, "created"), "changed");
    await expect(readonly.commit()).rejects.toThrow("Read-only");
    await absent(join(root, "created"));
  });

  test("rejects background stage mutations between requests and refreshes only a clean stage", async () => {
    const root = await fixture();
    await writeFile(join(root, "source"), "original");
    const workspace = await stage(root);
    await writeFile(join(root, "source"), "human");
    await workspace.refresh();
    expect(await readFile(join(workspace.root, "source"), "utf8")).toBe("human");
    await writeFile(join(workspace.root, "background"), "unowned");
    await expect(workspace.refresh()).rejects.toThrow("outside an authorized request");
    await absent(join(root, "background"));
  });

  test("normalizes special modes without treating unchanged host files as concurrent edits", async () => {
    const root = await fixture();
    await writeFile(join(root, "script"), "original");
    await chmod(join(root, "script"), 0o4755);
    const workspace = await stage(root);
    await workspace.commit();
    await writeFile(join(workspace.root, "script"), "changed");
    await workspace.commit();
    expect(await readFile(join(root, "script"), "utf8")).toBe("changed");
  });

  test("bounds oversized source files before copying their contents", async () => {
    const root = await fixture();
    await writeFile(join(root, "too-large"), "");
    await truncate(join(root, "too-large"), 64 * 1024 * 1024 + 1);
    await expect(stage(root)).rejects.toThrow("byte limit");
  });

  test("bounds total bytes from metadata before copying an oversized sparse tree", async () => {
    const root = await fixture();
    for (let index = 0; index < 9; index++) {
      const path = join(root, `large-${index}`);
      await writeFile(path, "");
      await truncate(path, 64 * 1024 * 1024);
    }
    await expect(stage(root)).rejects.toThrow("workspace exceeds its byte limit");
  });

  test("bounds traversal depth and directory entry counts", async () => {
    const deep = await fixture();
    await mkdir(join(deep, ...Array.from({ length: 66 }, () => "d")), { recursive: true });
    await expect(stage(deep)).rejects.toThrow("depth limit");
    const wide = await fixture();
    for (let first = 0; first < 20_001; first += 256)
      await Promise.all(
        Array.from({ length: Math.min(256, 20_001 - first) }, (_, index) =>
          mkdir(join(wide, `entry-${first + index}`)),
        ),
      );
    await expect(stage(wide)).rejects.toThrow("entry limit");
  }, 30_000);

  test("keeps private names filtered within a Git metadata copy", async () => {
    const root = await fixture();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", ".env"), "private");
    const workspace = await stage(root, { access: "read", allowGitRead: true });
    expect(await readFile(join(workspace.root, ".git", "HEAD"), "utf8")).toContain(
      "refs/heads/main",
    );
    await absent(join(workspace.root, ".git", ".env"));
  });
});
