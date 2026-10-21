/** Portable host capability; implementations live in the CLI platform boundary. */
export interface HostFileStat {
  size: number;
  nlink: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
}
export interface HostFileSystem {
  readonly root: string;
  close(): void;
  readBytes(path: string, maximum?: number): Uint8Array;
  readPrefix(path: string, maximum: number): Uint8Array;
  readText(path: string, maximum?: number): string;
  stat(path: string): HostFileStat | undefined;
  list(
    path?: string,
    maximum?: number,
  ): { name: string; kind: "file" | "directory" | "symlink" | "other" }[];
  mkdir(path: string, mode?: number): void;
  writeAtomic(path: string, content: string | Uint8Array, options?: { mode?: number }): void;
  delete(path: string): void;
}
export interface HostFileSystemOptions {
  allowProtectedPaths?: boolean;
  canonicalRoot?: boolean;
}
type Factory = (root: string, options?: HostFileSystemOptions) => HostFileSystem;
let factory: Factory | undefined;
export function installHostFileSystem(implementation: Factory): void {
  if (factory) throw new Error("Host filesystem capability already installed.");
  factory = implementation;
}
export function openHostFileSystem(root: string, options?: HostFileSystemOptions): HostFileSystem {
  if (!factory) throw new Error("Secure host filesystem capability is unavailable.");
  return factory(root, options);
}

const privateNames = new Set([
  ".git",
  ".vcli",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".kube",
  ".docker",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
]);

/** Portable credential/state boundary shared by native I/O, staging and indexing. */
export function isPrivateProjectPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const name = part.toLowerCase();
    return (
      privateNames.has(name) ||
      name.startsWith(".env") ||
      name === "credentials" ||
      (name.startsWith("credentials") && name.endsWith(".json")) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/.test(name)
    );
  });
}
