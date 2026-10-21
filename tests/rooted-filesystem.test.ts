import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryInterrupted, RootedFileSystem } from "../apps/cli/src/workflows/rooted-filesystem.ts";

const temporary: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vcli-rooted-fs-"));
  temporary.push(directory);
  const root = join(directory, "project");
  const outside = join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { directory, root, outside };
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("descriptor-rooted filesystem", () => {
  test("an uninterrupted signal storm is bounded and other I/O failures are never retried", () => {
    let attempts = 0;
    expect(() =>
      retryInterrupted(() => {
        attempts++;
        throw Object.assign(new Error("synthetic interrupted operation"), { code: "EINTR" });
      }),
    ).toThrow("synthetic interrupted operation");
    expect(attempts).toBe(17);
    attempts = 0;
    expect(() =>
      retryInterrupted(() => {
        attempts++;
        throw Object.assign(new Error("synthetic storage failure"), { code: "EIO" });
      }),
    ).toThrow("synthetic storage failure");
    expect(attempts).toBe(1);
  });
  test("interrupted directory creation is resolved by inspection without replaying the mutation", async () => {
    const { root } = fixture();
    const module = join(import.meta.dir, "../apps/cli/src/workflows/rooted-filesystem.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import {mock} from 'bun:test';
import * as ffi from 'bun:ffi';
const actual={...ffi};let creations=0;
mock.module('bun:ffi',()=>({...actual,dlopen(name,definitions){
  const library=actual.dlopen(name,definitions);
  if(!library.symbols.mkdirat)return library;
  const key=process.platform==='darwin'?'__error':'__errno_location';
  const errors=actual.dlopen(name,{[key]:{args:[],returns:'ptr'}});
  const errorState=new DataView(actual.toArrayBuffer(errors.symbols[key](),0,4));
  return {...library,symbols:{...library.symbols,mkdirat(...args){
    creations++;
    const result=library.symbols.mkdirat(...args);
    if(result===0){errorState.setInt32(0,4,true);return -1;}
    return result;
  }}};
}}));
const {RootedFileSystem}=await import(${JSON.stringify(module)});
using filesystem=new RootedFileSystem(${JSON.stringify(root)});
filesystem.mkdir('new/nested');const first=creations;
filesystem.mkdir('new/nested');if(creations!==first)process.exit(2);
filesystem.writeAtomic('new/nested/file','initial');const second=creations;
filesystem.writeAtomic('new/nested/file','persisted');
if(creations!==second||filesystem.readText('new/nested/file')!=='persisted')process.exit(3);
if(first!==2||second<=first)process.exit(4);console.log('INSPECTED');`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("INSPECTED");
    expect(await new Response(child.stderr).text()).toBe("");
  });
  test("private staging is tightened before data is written and private output modes are effective", () => {
    const { root } = fixture();
    const staging = join(root, ".vcli/state/fs-staging");
    mkdirSync(staging, { recursive: true, mode: 0o755 });
    chmodSync(staging, 0o755);
    using filesystem = new RootedFileSystem(root);
    filesystem.writeAtomic("private-fixture", "synthetic private fixture", {
      expected: null,
      mode: 0o600,
    });
    expect(statSync(staging).mode & 0o7777).toBe(0o700);
    expect(statSync(join(root, "private-fixture")).mode & 0o7777).toBe(0o600);
  });

  test("a filesystem that ignores permission changes refuses private bytes before creating a temporary file", async () => {
    const { root } = fixture();
    const staging = join(root, ".vcli/state/fs-staging");
    mkdirSync(staging, { recursive: true, mode: 0o755 });
    chmodSync(staging, 0o755);
    const module = join(import.meta.dir, "../apps/cli/src/workflows/rooted-filesystem.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import {mock} from 'bun:test';
import * as fs from 'node:fs';
const actual={...fs};
mock.module('node:fs',()=>({...actual,fchmodSync(){}}));
const {RootedFileSystem}=await import(${JSON.stringify(module)});
using filesystem=new RootedFileSystem(${JSON.stringify(root)});
try {filesystem.writeAtomic('private-fixture','must remain unwritten',{mode:0o600});process.exit(2);}
catch(error) {if(!error.message.includes('enforce Unix permission modes'))throw error;console.log('REFUSED');}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("REFUSED");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(readdirSync(staging)).toEqual([]);
    expect(await Bun.file(join(root, "private-fixture")).exists()).toBe(false);
  });
  test("bounds real bytes and preserves native bytes and file mode on atomic replacement", () => {
    const { root } = fixture();
    writeFileSync(join(root, "script"), Buffer.from([0xff, 0, 0x41, 0x0a]));
    chmodSync(join(root, "script"), 0o751);
    using filesystem = new RootedFileSystem(root);
    const before = filesystem.snapshot("script")!;
    expect(before.content).toEqual(Buffer.from([0xff, 0, 0x41, 0x0a]));
    expect(() => filesystem.readBytes("script", 3)).toThrow("byte limit");
    expect(filesystem.readBytes("script", 4)).toHaveLength(4);
    expect(filesystem.readPrefix("script", 2)).toEqual(Buffer.from([0xff, 0]));
    filesystem.writeAtomic("script", Buffer.from([0, 0xfe]), { expected: before });
    const after = filesystem.snapshot("script")!;
    expect(after.content).toEqual(Buffer.from([0, 0xfe]));
    expect(after.mode).toBe(0o751);
    expect(after.identity.ino).not.toBe(before.identity.ino);
  });

  test("rejects every link component, hard links, traversal, protected paths, and closed roots", () => {
    const { root, outside } = fixture();
    writeFileSync(join(outside, "secret"), "outside");
    symlinkSync(outside, join(root, "linked"));
    linkSync(join(outside, "secret"), join(root, "hard"));
    using filesystem = new RootedFileSystem(root);
    expect(() => filesystem.readText("linked/secret")).toThrow();
    expect(() => filesystem.writeAtomic("linked/secret", "changed")).toThrow();
    expect(() => filesystem.mkdir("linked/new-directory")).toThrow();
    expect(() => filesystem.delete("linked/secret")).toThrow();
    expect(() => filesystem.readText("hard")).toThrow("hard links");
    expect(() => filesystem.writeAtomic("hard", "changed")).toThrow("hard links");
    expect(() => filesystem.readText("../outside/secret")).toThrow("traversal");
    expect(() => filesystem.readText(join(outside, "secret"))).toThrow("inside");
    expect(() => filesystem.stat(".VcLi/config.json")).toThrow("protected");
    expect(() => filesystem.mkdir(".git/objects")).toThrow("protected");
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
    filesystem.close();
    expect(() => filesystem.readText("a")).toThrow("closed");
  });

  test("lists entries without following links and allows private stores only explicitly", () => {
    const { root, outside } = fixture();
    mkdirSync(join(root, "subdirectory"));
    symlinkSync(outside, join(root, "link"));
    writeFileSync(join(root, "file"), "content");
    using filesystem = new RootedFileSystem(root);
    expect(filesystem.list()).toEqual([
      { name: "file", kind: "file" },
      { name: "link", kind: "symlink" },
      { name: "subdirectory", kind: "directory" },
    ]);
    expect(() => filesystem.list(".", 1)).toThrow("entry limit");
    expect(filesystem.readLink("link")).toBe(outside);
    using privateStore = new RootedFileSystem(root, { allowProtectedPaths: true });
    privateStore.writeAtomic(".vcli/test-metadata.json", "metadata", {
      expected: null,
      mode: 0o600,
    });
    expect(privateStore.readText(".vcli/test-metadata.json")).toBe("metadata");
    expect(() => filesystem.readText(".vcli/test-metadata.json")).toThrow("protected");
  });

  test("atomic creates never replace a concurrent file and explicit hashes protect edits", () => {
    const { root } = fixture();
    using filesystem = new RootedFileSystem(root);
    filesystem.writeAtomic("new/directories/file", "initial", { expected: null });
    const expected = filesystem.snapshot("new/directories/file")!;
    writeFileSync(join(root, "new/directories/file"), "external edit");
    expect(() =>
      filesystem.writeAtomic("new/directories/file", "replacement", { expected }),
    ).toThrow("changed");
    expect(() =>
      filesystem.writeAtomic("new/directories/file", "replacement", { expected: null }),
    ).toThrow("changed");
    expect(() => filesystem.delete("new/directories/file", { expected })).toThrow("changed");
    expect(filesystem.readText("new/directories/file")).toBe("external edit");
    filesystem.delete("new/directories/file", {
      expected: filesystem.snapshot("new/directories/file")!,
    });
    expect(filesystem.snapshot("new/directories/file")).toBeUndefined();
    expect(() => filesystem.list(".missing")).toThrow();
  });

  test("an opened file and root remain pinned when their original names become symlinks", () => {
    const { directory, root, outside } = fixture();
    const canonicalRoot = realpathSync(root);
    mkdirSync(join(root, "parent"));
    writeFileSync(join(root, "parent/file"), "allowed");
    writeFileSync(join(outside, "file"), "secret");
    using filesystem = new RootedFileSystem(root);
    filesystem.withFile("parent/file", (fd) => {
      renameSync(join(root, "parent"), join(root, "original-parent"));
      symlinkSync(outside, join(root, "parent"));
      const content = Buffer.alloc(7);
      readSync(fd, content);
      expect(content.toString()).toBe("allowed");
    });
    expect(() => filesystem.readText("parent/file")).toThrow();
    renameSync(root, join(directory, "original-root"));
    symlinkSync(outside, root);
    expect(() => new RootedFileSystem(canonicalRoot, { canonicalRoot: true })).toThrow(
      "symbolic link",
    );
    expect(() => new RootedFileSystem(root)).toThrow("symbolic link");
    expect(filesystem.readText("original-parent/file")).toBe("allowed");
    filesystem.writeAtomic("original-parent/file", "safe", {
      expected: filesystem.snapshot("original-parent/file")!,
    });
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("secret");
  });

  test("a symlink swapper cannot redirect descriptor reads or atomic writes outside the root", async () => {
    const { root, outside, directory } = fixture();
    mkdirSync(join(root, "moving"));
    writeFileSync(join(root, "moving/file"), "allowed");
    writeFileSync(join(outside, "file"), "secret");
    const ready = join(directory, "ready");
    const stop = join(directory, "stop");
    const swapper = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import {existsSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
const [root,outside,ready,stop]=process.argv.slice(1);
writeFileSync(ready,'ready');
while(!existsSync(stop)) {
  try {renameSync(root+'/moving',root+'/parked');} catch {}
  try {symlinkSync(outside,root+'/moving');} catch {}
  try {unlinkSync(root+'/moving');} catch {}
  try {renameSync(root+'/parked',root+'/moving');} catch {}
}
try {unlinkSync(root+'/moving');} catch {}
try {renameSync(root+'/parked',root+'/moving');} catch {}`,
        root,
        outside,
        ready,
        stop,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const start = Date.now();
      while (!Bun.file(ready).size) {
        if (Date.now() - start > 5000) throw new Error("Filesystem race fixture did not start.");
        await Bun.sleep(5);
      }
      using filesystem = new RootedFileSystem(root);
      let completedReads = 0;
      let completedWrites = 0;
      for (let index = 0; index < 1000; index++) {
        let content: string | undefined;
        try {
          content = filesystem.readText("moving/file");
        } catch {
          // Missing paths and links are refused while the adversary swaps entries.
        }
        if (content !== undefined) {
          expect(content).toBe("allowed");
          completedReads++;
        }
        try {
          filesystem.writeAtomic("moving/file", "allowed");
          completedWrites++;
        } catch {
          // Missing paths and links are refused while the adversary swaps entries.
        }
      }
      expect(completedReads).toBeGreaterThan(0);
      expect(completedWrites).toBeGreaterThan(0);
    } finally {
      writeFileSync(stop, "stop");
      const exit = await swapper.exited;
      const stderr = await new Response(swapper.stderr).text();
      expect(stderr).toBe("");
      expect(exit).toBe(0);
    }
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("secret");
  }, 20_000);

  test("pinned directory capabilities have an independent lifetime", () => {
    const { root } = fixture();
    const filesystem = new RootedFileSystem(root);
    const directory = filesystem.openDirectory();
    expect(directory.fd).not.toBe(filesystem.rootFd);
    filesystem.close();
    directory.close();
    directory.close();
    expect(() => closeSync(directory.fd)).toThrow();
  });

  test("reopening a replaced directory root refuses a new inode authority", () => {
    const { directory, root } = fixture();
    using filesystem = new RootedFileSystem(root);
    renameSync(root, join(directory, "original-project"));
    mkdirSync(root);
    expect(() => new RootedFileSystem(root)).toThrow("root identity changed");
    expect(filesystem.list()).toEqual([]);
  });

  test("directory removal is anchored, empty-only, and refuses replacement links", () => {
    const { root, outside } = fixture();
    using filesystem = new RootedFileSystem(root);
    filesystem.mkdir("empty");
    filesystem.removeDirectory("empty");
    expect(filesystem.stat("empty")).toBeUndefined();
    filesystem.writeAtomic("populated/file", "retained", { expected: null });
    expect(() => filesystem.removeDirectory("populated")).toThrow();
    symlinkSync(outside, join(root, "outside-link"));
    expect(() => filesystem.removeDirectory("outside-link")).toThrow("symbolic links");
    expect(filesystem.readText("populated/file")).toBe("retained");
  });
});
