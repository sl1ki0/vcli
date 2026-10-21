import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync as rawFchmodSync,
  fstatSync as rawFstatSync,
  fsyncSync as rawFsyncSync,
  readSync as rawReadSync,
  realpathSync,
  writeSync as rawWriteSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CString, dlopen, toArrayBuffer, type FFIFunction } from "bun:ffi";
import { privateProjectPath } from "./private-path.ts";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const INTERRUPT_RETRIES = 16;

/** Only use for repeatable operations. close and namespace mutations are excluded. */
export function retryInterrupted<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EINTR" || attempt >= INTERRUPT_RETRIES)
        throw error;
    }
  }
}

function interruptible<F extends (...args: never[]) => unknown>(operation: F): F {
  return ((...args: unknown[]) =>
    retryInterrupted(() => Reflect.apply(operation, undefined, args))) as unknown as F;
}
const fchmodSync = interruptible(rawFchmodSync);
const fstatSync = interruptible(rawFstatSync);
const fsyncSync = interruptible(rawFsyncSync);
const readSync = interruptible(rawReadSync);
const writeSync = interruptible(rawWriteSync);
const ROOT_BINDING_LIMIT = 1024;
const rootBindings = new Map<string, { canonical: string; dev: bigint; ino: bigint }>();
const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x80000;
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;

const definitions = {
  openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
  mkdirat: { args: ["i32", "cstring", "u32"], returns: "i32" },
  renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
  linkat: { args: ["i32", "cstring", "i32", "cstring", "i32"], returns: "i32" },
  unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  fdopendir: { args: ["i32"], returns: "ptr" },
  readdir: { args: ["ptr"], returns: "ptr" },
  closedir: { args: ["ptr"], returns: "i32" },
  readlinkat: { args: ["i32", "cstring", "ptr", "usize"], returns: "i64" },
  flock: { args: ["i32", "i32"], returns: "i32" },
} as const satisfies Record<string, FFIFunction>;

function loadNative() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Descriptor-rooted filesystem access requires macOS or Linux/WSL.");
  const names =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
  for (const name of names) {
    try {
      const library = dlopen(name, definitions);
      const errno =
        process.platform === "darwin"
          ? dlopen(name, { __error: { args: [], returns: "ptr" } }).symbols.__error
          : dlopen(name, { __errno_location: { args: [], returns: "ptr" } }).symbols
              .__errno_location;
      const pointer = errno();
      if (!pointer) throw new Error("System errno is unavailable.");
      // Creating a JS view after a failed syscall may itself enter native code
      // and disturb errno. Allocate the thread-local view before any I/O.
      const errorState = new DataView(toArrayBuffer(pointer, 0, 4));
      return { symbols: library.symbols, errorState };
    } catch {
      // Never fall back to pathname-based filesystem calls.
    }
  }
  throw new Error("System descriptor-rooted filesystem primitives are unavailable.");
}

let loaded: ReturnType<typeof loadNative> | undefined;
function native() {
  return (loaded ??= loadNative());
}
const cstring = (value: string): Buffer => Buffer.from(`${value}\0`);

function systemError(operation: string): NodeJS.ErrnoException {
  const errno = native().errorState.getInt32(0, true);
  const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
  return Object.assign(new Error(`${operation} refused (${code}).`), {
    code,
    errno,
    syscall: operation,
  });
}
function clearErrno(): void {
  native().errorState.setInt32(0, 0, true);
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

function openAt(fd: number, name: string, flags: number, mode = 0): number {
  for (let attempt = 0; ; attempt++) {
    const result = native().symbols.openat(fd, cstring(name), flags, mode);
    if (result >= 0) return result;
    const error = systemError("Opening a project path");
    if (error.code === "EINTR" && !(flags & constants.O_CREAT) && attempt < INTERRUPT_RETRIES)
      continue;
    if (error.code === "ELOOP" || error.code === "ENOTDIR")
      error.message = `Filesystem access requires a regular file or directory without symbolic links or non-directory ancestors (${error.code}).`;
    throw error;
  }
}

function regular(fd: number): Stats {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("Filesystem access requires regular files without hard links.");
  return stat;
}

/** chmod may silently do nothing on filesystems without Unix permission metadata. */
export function enforceUnixMode(fd: number, mode: number): void {
  if (typeof process.geteuid === "function" && fstatSync(fd).uid !== process.geteuid())
    throw new Error("Private storage must be owned by the current user.");
  fchmodSync(fd, mode);
  if ((fstatSync(fd).mode & 0o7777) !== mode)
    throw new Error(
      "Filesystem must enforce Unix permission modes before private data can be stored.",
    );
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export interface RootedFileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}
export interface RootedFileSnapshot {
  content: Buffer;
  digest: string;
  mode: number;
  identity: RootedFileIdentity;
}
export interface RootedFileExpectation {
  digest: string;
  mode?: number;
}
export interface RootedWriteOptions {
  mode?: number;
  /** null requires an absent destination; undefined permits the current destination. */
  expected?: RootedFileExpectation | null;
}
export interface RootedEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

/** A pinned directory capability. Callers must keep it open until a child drains. */
export class RootedDirectory {
  private closed = false;
  constructor(readonly fd: number) {}

  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Actual I/O resolves each component against an already-open directory descriptor.
 * A preceding policy/pathname check is never used as the filesystem capability.
 *
 * Atomic replacement avoids hard-link write-through and partial file contents.
 * Expected hashes detect conflicts; POSIX rename/unlink provide no content CAS
 * against arbitrary concurrent same-user host writers. Those writers are outside
 * the child-process sandbox boundary and must not be described as serialized.
 */
export class RootedFileSystem {
  readonly root: string;
  readonly rootFd: number;
  private readonly launchRoot: string;
  private readonly allowProtectedPaths: boolean;
  private closed = false;

  constructor(
    root: string,
    options: {
      allowProtectedPaths?: boolean;
      canonicalRoot?: boolean;
      /** Only for private disposable directories created by trusted host code. */
      ephemeral?: boolean;
    } = {},
  ) {
    this.launchRoot = resolve(root);
    const binding = options.ephemeral ? undefined : rootBindings.get(this.launchRoot);
    this.root =
      binding?.canonical ??
      (options.canonicalRoot ? this.launchRoot : realpathSync(this.launchRoot));
    this.allowProtectedPaths = options.allowProtectedPaths === true;
    // Walk from / as well: O_NOFOLLOW on just the last root component is insufficient.
    let fd = openAt(process.platform === "darwin" ? -2 : -100, "/", directoryFlags);
    try {
      for (const component of this.root.split(sep).filter(Boolean)) {
        const next = openAt(fd, component, directoryFlags);
        closeSync(fd);
        fd = next;
      }
      const info = fstatSync(fd, { bigint: true });
      const canonicalBinding = options.ephemeral ? undefined : rootBindings.get(this.root);
      for (const known of [binding, canonicalBinding]) {
        if (known && (known.dev !== info.dev || known.ino !== info.ino))
          throw new Error(
            "Workspace root identity changed; restart after verifying the project location.",
          );
      }
      const keys = options.ephemeral ? [] : [...new Set([this.launchRoot, this.root])];
      if (
        rootBindings.size + keys.filter((key) => !rootBindings.has(key)).length >
        ROOT_BINDING_LIMIT
      )
        throw new Error(
          "Root filesystem capability limit reached; restart before opening more roots.",
        );
      const authority = { canonical: this.root, dev: info.dev, ino: info.ino };
      for (const key of keys) rootBindings.set(key, authority);
      this.rootFd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.rootFd);
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private components(path: string, allowProtected = this.allowProtectedPaths): string[] {
    if (this.closed) throw new Error("Rooted filesystem is closed.");
    if (!path || path.includes("\0") || path.includes("\\") || path.split("/").includes(".."))
      throw new Error("Project paths cannot contain traversal, backslashes, or NUL bytes.");
    const requested = resolve(this.launchRoot, path);
    const launchRelative = relative(this.launchRoot, requested);
    const canonical =
      launchRelative === "" ||
      (launchRelative !== ".." &&
        !launchRelative.startsWith(`..${sep}`) &&
        !isAbsolute(launchRelative))
        ? resolve(this.root, launchRelative)
        : requested;
    const part = relative(this.root, canonical);
    if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new Error("Path must remain inside the project workspace.");
    const components = part.split(sep).filter(Boolean);
    if (!allowProtected && privateProjectPath(components.join("/")))
      throw new Error(
        "Agent tools cannot access private credentials or protected project configuration or state.",
      );
    return components;
  }

  private directory(components: string[], create = false, mode = 0o700): RootedDirectory {
    let fd = openAt(this.rootFd, ".", directoryFlags);
    try {
      for (const component of components) {
        let next: number;
        try {
          next = openAt(fd, component, directoryFlags);
        } catch (error) {
          if (!create || !missing(error)) throw error;
          native().symbols.mkdirat(fd, cstring(component), mode);
          // Resolve concurrent or interrupted creation by inspecting its result.
          // Never replay the namespace mutation after an uncertain outcome.
          next = openAt(fd, component, directoryFlags);
        }
        closeSync(fd);
        fd = next;
      }
      return new RootedDirectory(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  openDirectory(path = "."): RootedDirectory {
    return this.directory(this.components(path));
  }

  private parent(path: string, create = false): { directory: RootedDirectory; name: string } {
    const components = this.components(path);
    const name = components.pop();
    if (!name) throw new Error("A project file path is required.");
    return { directory: this.directory(components, create), name };
  }

  withFile<T>(path: string, operation: (fd: number, stat: Stats) => T): T {
    const { directory, name } = this.parent(path);
    try {
      const fd = openAt(directory.fd, name, fileFlags);
      try {
        return operation(fd, regular(fd));
      } finally {
        closeSync(fd);
      }
    } finally {
      directory.close();
    }
  }

  snapshot(path: string, maximum = MAX_FILE_BYTES): RootedFileSnapshot | undefined {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new Error("A nonnegative safe file byte limit is required.");
    try {
      return this.withFile(path, (fd) => {
        const before = fstatSync(fd, { bigint: true });
        if (before.size > BigInt(maximum)) throw new Error("File exceeds its byte limit.");
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (bytes <= maximum) {
          const buffer = Buffer.alloc(Math.min(65_536, maximum + 1 - bytes));
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          bytes += count;
          if (bytes > maximum) throw new Error("File exceeds its byte limit.");
          chunks.push(buffer.subarray(0, count));
        }
        const after = fstatSync(fd, { bigint: true });
        if (!sameIdentity(before, after) || after.nlink !== 1n)
          throw new Error("File changed while reading; retry after concurrent writes finish.");
        const content = Buffer.concat(chunks, bytes);
        return {
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          mode: Number(after.mode & 0o7777n),
          identity: {
            dev: after.dev.toString(),
            ino: after.ino.toString(),
            size: Number(after.size),
            mtimeNs: after.mtimeNs.toString(),
            ctimeNs: after.ctimeNs.toString(),
          },
        };
      });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  readBytes(path: string, maximum = MAX_FILE_BYTES): Buffer {
    const snapshot = this.snapshot(path, maximum);
    if (!snapshot)
      throw Object.assign(new Error("Project file does not exist."), { code: "ENOENT" });
    return snapshot.content;
  }

  /** Bounded metadata reads retain the descriptor and never buffer the full file. */
  readPrefix(path: string, maximum: number): Buffer {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new Error("A nonnegative safe file prefix byte limit is required.");
    return this.withFile(path, (fd) => {
      const before = fstatSync(fd, { bigint: true });
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes < maximum) {
        const buffer = Buffer.alloc(Math.min(65_536, maximum - bytes));
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count;
        chunks.push(buffer.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true });
      if (!sameIdentity(before, after) || after.nlink !== 1n)
        throw new Error("File changed while reading; retry after concurrent writes finish.");
      return Buffer.concat(chunks, bytes);
    });
  }

  readText(path: string, maximum = MAX_FILE_BYTES): string {
    return this.readBytes(path, maximum).toString("utf8");
  }

  stat(path: string): Stats | undefined {
    const components = this.components(path);
    if (!components.length) return fstatSync(this.rootFd);
    const name = components.pop()!;
    let directory: RootedDirectory | undefined;
    let fd: number | undefined;
    try {
      directory = this.directory(components);
      fd = openAt(directory.fd, name, fileFlags);
      const stat = fstatSync(fd);
      if (!stat.isDirectory()) regular(fd);
      return stat;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      directory?.close();
    }
  }

  list(path = ".", maximum = 20_000): RootedEntry[] {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new Error("A nonnegative safe directory entry limit is required.");
    const directory = this.openDirectory(path);
    // fdopendir consumes this fresh descriptor, never the persistent root capability.
    const iterator = native().symbols.fdopendir(directory.fd);
    if (!iterator) {
      const error = systemError("Listing a project directory");
      directory.close();
      throw error;
    }
    const entries: RootedEntry[] = [];
    try {
      while (true) {
        clearErrno();
        const pointer = native().symbols.readdir(iterator);
        if (!pointer) {
          const error = systemError("Listing a project directory");
          if (error.errno) throw error;
          break;
        }
        const darwin = process.platform === "darwin";
        const name = new CString(pointer, darwin ? 21 : 19).toString();
        if (name === "." || name === "..") continue;
        if (entries.length >= maximum)
          throw new Error("Project directory exceeds its entry limit.");
        if (!name || name.includes("/") || name.includes("\0") || name.includes("\uFFFD"))
          throw new Error("Project directory contains an unsupported filename.");
        const type = new DataView(toArrayBuffer(pointer, darwin ? 20 : 18, 1)).getUint8(0);
        let kind: RootedEntry["kind"] =
          type === 4 ? "directory" : type === 8 ? "file" : type === 10 ? "symlink" : "other";
        if (type === 0) {
          // d_type may be DT_UNKNOWN on NFS/WSL: do not silently omit entries.
          const probe = Buffer.alloc(1);
          if (native().symbols.readlinkat(directory.fd, cstring(name), probe, 1) >= 0)
            kind = "symlink";
          else {
            const error = systemError("Classifying a project entry");
            if (error.code !== "EINVAL") throw error;
            const fd = openAt(directory.fd, name, fileFlags);
            try {
              const stat = fstatSync(fd);
              kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
            } finally {
              closeSync(fd);
            }
          }
        }
        entries.push({
          name,
          kind,
        });
      }
    } finally {
      native().symbols.closedir(iterator);
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  readLink(path: string, maximum = 16_384): string {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new Error("A nonnegative safe link byte limit is required.");
    const { directory, name } = this.parent(path);
    try {
      const buffer = Buffer.alloc(maximum + 1);
      const count = Number(
        native().symbols.readlinkat(directory.fd, cstring(name), buffer, buffer.length),
      );
      if (count < 0) throw systemError("Reading a project link");
      if (count > maximum) throw new Error("Project link exceeds its byte limit.");
      return buffer.subarray(0, count).toString("utf8");
    } finally {
      directory.close();
    }
  }

  mkdir(path: string, mode = 0o700): void {
    this.directory(this.components(path), true, mode).close();
  }

  private checkExpected(path: string, expected: RootedFileExpectation | null | undefined): void {
    if (expected === undefined) return;
    const current = this.snapshot(path, 128 * 1024 * 1024);
    if (
      (expected === null && current !== undefined) ||
      (expected !== null &&
        (!current ||
          current.digest !== expected.digest ||
          (expected.mode !== undefined && current.mode !== expected.mode)))
    )
      throw Object.assign(
        new Error("File changed before mutation; operation refused to preserve external edits."),
        { code: expected === null ? "EEXIST" : "ESTALE" },
      );
  }

  writeAtomic(path: string, content: string | Uint8Array, options: RootedWriteOptions = {}): void {
    const existing = this.stat(path);
    if (existing && !existing.isFile())
      throw new Error("Atomic replacement requires a regular file destination.");
    const { directory, name } = this.parent(path, true);
    // Agent subprocesses cannot access .vcli. Staging there also prevents them
    // replacing an output filename between its descriptor write and installation.
    let staging: RootedDirectory | undefined;
    const temporary = randomUUID();
    let fd: number | undefined;
    let installed = false;
    try {
      staging = this.directory([".vcli", "state", "fs-staging"], true);
      enforceUnixMode(staging.fd, 0o700);
      fd = openAt(
        staging.fd,
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          closeOnExec,
        0o600,
      );
      regular(fd);
      enforceUnixMode(fd, 0o600);
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (!written) throw new Error("Filesystem write made no progress.");
        offset += written;
      }
      enforceUnixMode(
        fd,
        options.mode ?? (existing ? existing.mode & 0o7777 : 0o666 & ~process.umask()),
      );
      fsyncSync(fd);
      this.checkExpected(path, options.expected);
      if (options.expected === null) {
        // linkat is an atomic no-replace install, so concurrent creates survive.
        if (
          native().symbols.linkat(staging.fd, cstring(temporary), directory.fd, cstring(name), 0) <
          0
        )
          throw systemError("Creating a project file atomically");
      } else if (
        native().symbols.renameat(staging.fd, cstring(temporary), directory.fd, cstring(name)) < 0
      )
        throw systemError("Replacing a project file atomically");
      installed = true;
      fsyncSync(directory.fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (staging && (!installed || options.expected === null))
        native().symbols.unlinkat(staging.fd, cstring(temporary), 0);
      staging?.close();
      directory.close();
    }
  }

  delete(path: string, options: { expected?: RootedFileExpectation } = {}): void {
    this.withFile(path, () => {});
    const { directory, name } = this.parent(path);
    try {
      this.checkExpected(path, options.expected);
      if (native().symbols.unlinkat(directory.fd, cstring(name), 0) < 0)
        throw systemError("Deleting a project file");
      fsyncSync(directory.fd);
    } finally {
      directory.close();
    }
  }

  /** Process-scoped OS lock; keep the lock inode and descriptor until close. */
  lock(path: string): RootedDirectory {
    const { directory, name } = this.parent(path, true);
    let fd: number | undefined;
    try {
      fd = openAt(
        directory.fd,
        name,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          closeOnExec,
        0o600,
      );
      regular(fd);
      if (native().symbols.flock(fd, 2 | 4) < 0) {
        const error = systemError("Locking a private store");
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
          error.message =
            "This private store is locked by another vcli process; close it before reopening.";
        throw error;
      }
      enforceUnixMode(fd, 0o600);
      const lock = new RootedDirectory(fd);
      fd = undefined;
      return lock;
    } finally {
      if (fd !== undefined) closeSync(fd);
      directory.close();
    }
  }

  /** Remove only an empty directory; never recursively traverse a mutable tree. */
  removeDirectory(path: string): void {
    const pinned = this.openDirectory(path);
    let parent: ReturnType<RootedFileSystem["parent"]> | undefined;
    try {
      parent = this.parent(path);
      if (
        native().symbols.unlinkat(
          parent.directory.fd,
          cstring(parent.name),
          process.platform === "darwin" ? 0x80 : 0x200,
        ) < 0
      )
        throw systemError("Removing an empty project directory");
    } finally {
      pinned.close();
      parent?.directory.close();
    }
  }

  rename(source: string, destination: string): void {
    this.withFile(source, () => {});
    const from = this.parent(source);
    let to: ReturnType<RootedFileSystem["parent"]> | undefined;
    try {
      to = this.parent(destination, true);
      if (
        native().symbols.renameat(
          from.directory.fd,
          cstring(from.name),
          to.directory.fd,
          cstring(to.name),
        ) < 0
      )
        throw systemError("Renaming a project file");
    } finally {
      from.directory.close();
      to?.directory.close();
    }
  }
}
