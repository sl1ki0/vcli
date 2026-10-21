import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  decodeMcpMessage,
  encodeMcpMessage,
  type McpRpcMessage,
  type McpStdioTransportFactory,
  type McpStdioTransportOptions,
  type McpTransport,
} from "@vcli/integrations";
import type { NormalizedMcpServer } from "@vcli/core";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareSandbox } from "./process-sandbox.ts";
import { createSandboxWorkspace } from "./sandbox-workspace.ts";
import { materializeSandboxPackage } from "./sandbox-package.ts";

export interface IsolatedMcpProcess {
  child: ChildProcessWithoutNullStreams;
  /** Must kill and drain every descendant, then release the isolation resources. */
  dispose(): Promise<void>;
  beforeRequest?(): Promise<void>;
  beforeResponse?(): Promise<void>;
}
export type IsolatedMcpLauncher = (
  server: NormalizedMcpServer,
  signal: AbortSignal,
) => Promise<IsolatedMcpProcess>;

/** JSON-RPC framing around a host-owned isolated subprocess, never an SDK spawn. */
class IsolatedStdioTransport implements McpTransport {
  onclose?: McpTransport["onclose"];
  onerror?: McpTransport["onerror"];
  onmessage?: McpTransport["onmessage"];
  private process?: IsolatedMcpProcess;
  private opening?: Promise<void>;
  private launching?: Promise<IsolatedMcpProcess>;
  private closing?: Promise<void>;
  private closed = false;
  private closeReported = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private diagnosticBytes = 0;
  private receiving = Promise.resolve();
  private queuedBytes = 0;
  private requestId?: string | number;
  private readonly controller = new AbortController();

  constructor(
    private readonly server: NormalizedMcpServer,
    private readonly options: McpStdioTransportOptions,
    private readonly launch: IsolatedMcpLauncher,
  ) {}

  start(): Promise<void> {
    if (this.opening) return Promise.reject(new Error("MCP transport already started"));
    if (this.closed) return Promise.reject(new Error("MCP transport is closed"));
    this.opening = this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    const process = await (this.launching = this.launch(this.server, this.controller.signal));
    this.process = process;
    if (this.closed) {
      throw new Error("MCP transport closed during startup");
    }
    const child = process.child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const room = 16_384 - this.diagnosticBytes;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      this.diagnosticBytes += part.byteLength;
      this.options.onDiagnostic?.(part.toString("utf8"));
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("error", (error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    // Exit is observed before close: detached descendants holding stdio must not
    // keep the client alive or make teardown wait for untrusted pipe ownership.
    child.once("exit", () => void this.close());
    if (child.exitCode !== null || child.signalCode !== null) {
      void this.close();
      throw new Error("MCP server exited during startup");
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.onerror?.(error);
    void this.close().catch(() => undefined);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.pendingBytes + part.length > this.options.maxResponseBytes) {
        this.fail(new Error(`MCP response exceeded ${this.options.maxResponseBytes} bytes`));
        return;
      }
      if (part.length) this.pending.push(part);
      this.pendingBytes += part.length;
      if (newline < 0) return;
      try {
        const size = this.pendingBytes;
        const message = decodeMcpMessage(Buffer.concat(this.pending).toString("utf8"));
        this.pending = [];
        this.pendingBytes = 0;
        this.queuedBytes += size;
        if (this.queuedBytes > this.options.maxResponseBytes) {
          this.fail(
            new Error(`MCP queued responses exceeded ${this.options.maxResponseBytes} bytes`),
          );
          return;
        }
        this.receiving = this.receiving
          .then(async () => {
            if (this.closed) return;
            if (!("method" in message) && "id" in message) {
              if (this.requestId === undefined || message.id !== this.requestId)
                throw new Error("MCP server returned an unexpected response identity");
              await this.process?.beforeResponse?.();
              this.requestId = undefined;
            }
            if (!this.closed) this.onmessage?.(message);
          })
          .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            this.queuedBytes -= size;
          });
      } catch {
        this.fail(new Error("MCP server sent an invalid JSON-RPC frame"));
        return;
      }
      if (this.closed) return;
      offset = newline + 1;
    }
  }

  async send(message: McpRpcMessage): Promise<void> {
    if (this.closed || !this.process) throw new Error("MCP transport is not connected");
    const frame = encodeMcpMessage(message);
    if (Buffer.byteLength(frame) > this.options.maxResponseBytes)
      throw new Error(`MCP request exceeded ${this.options.maxResponseBytes} bytes`);
    const child = this.process.child;
    if ("method" in message && "id" in message) {
      if (this.requestId !== undefined) throw new Error("MCP stdio requests must run serially");
      this.requestId = message.id;
      try {
        await this.process.beforeRequest?.();
      } catch (error) {
        this.requestId = undefined;
        this.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.controller.abort(new Error("MCP transport closed"));
    this.closing ??= (async () => {
      // Report closure immediately so pending SDK requests reject even while a
      // sandbox launcher is still preparing a process that must be drained.
      if (!this.closeReported) {
        this.closeReported = true;
        this.onclose?.();
      }
      const process = await this.launching?.catch(() => undefined);
      await this.receiving;
      await process?.dispose();
      this.pending = [];
      this.pendingBytes = 0;
    })();
    return this.closing;
  }
}

export function isolatedMcpTransport(launch: IsolatedMcpLauncher): McpStdioTransportFactory {
  return (server, options) => new IsolatedStdioTransport(server, options, launch);
}

/** Explicit MCP values are intentional grants; runtime injection is never a grant. */
export function mcpEnvironment(explicit: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"])
    if (process.env[key] !== undefined) environment[key] = process.env[key]!;
  for (const [key, value] of Object.entries(explicit)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
      throw new Error("Invalid MCP environment entry");
    if (
      /^(?:BASH_|BUN_|DYLD_|LD_|GIT_|NODE_|NPM_|npm_|PYTHON|RUBY|PERL|ZDOTDIR$|ENV$|SHELLOPTS$|BASHOPTS$)/.test(
        key,
      )
    )
      throw new Error(`MCP runtime injection variable is unsupported: ${key}`);
    environment[key] = value;
  }
  return environment;
}

/** All stdio servers enter the same mandatory system sandbox as shell and hooks. */
export function sandboxedMcpTransport(
  root: string,
  pluginRoots: ReadonlyMap<string, string> = new Map(),
): McpStdioTransportFactory {
  return isolatedMcpTransport(async (server, signal) => {
    signal.throwIfAborted();
    if (server.type !== "stdio" || !server.command)
      throw new Error("MCP stdio requires an executable");
    const canonicalRoot = await realpath(root);
    const pluginRoot = pluginRoots.get(server.name);
    const cwd = resolve(root, server.cwd ?? ".");
    const within = (parent: string) => {
      const path = relative(parent, cwd);
      return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
    };
    if (!within(root) && !(pluginRoot && within(pluginRoot)))
      throw new Error("MCP working directory must stay in the project or installed plugin");
    const workspace = await createSandboxWorkspace({ root: canonicalRoot, access: "write" });
    if (signal.aborted) {
      await workspace.dispose();
      signal.throwIfAborted();
    }
    let packageRoot: string | undefined;
    if (pluginRoot) {
      packageRoot = join(
        workspace.root,
        ".vcli-plugins",
        createHash("sha256").update(server.name).digest("hex"),
      );
      try {
        await mkdir(packageRoot, { recursive: true, mode: 0o700 });
        await materializeSandboxPackage(packageRoot, pluginRoot);
      } catch (error) {
        await workspace.dispose();
        throw error;
      }
    }
    const mapValue = (value: string): string => {
      if (!isAbsolute(value)) return value;
      if (pluginRoot && packageRoot) {
        const path = relative(pluginRoot, value);
        if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
          return join(packageRoot, path);
      }
      for (const original of [root, canonicalRoot]) {
        const path = relative(original, value);
        if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
          return workspace.mapPath(join(canonicalRoot, path));
      }
      return value;
    };
    const prepared = await prepareSandbox({
      root: workspace.root,
      originalRoot: workspace.originalRoot,
      cwd: mapValue(cwd),
      command: mapValue(server.command),
      args: (server.args ?? []).map(mapValue),
      environment: Object.fromEntries(
        Object.entries(mcpEnvironment(server.env)).map(([key, value]) => [key, mapValue(value)]),
      ),
      readOnlyDirectories: packageRoot ? [packageRoot] : [],
      access: "write",
      staged: true,
      signal,
    }).catch(async (error) => {
      await workspace.dispose();
      throw error;
    });
    if (signal.aborted) {
      try {
        await prepared.dispose();
      } finally {
        await workspace.dispose();
      }
      signal.throwIfAborted();
    }
    const child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", ...(prepared.stdioFds ?? [])],
    }) as ChildProcessWithoutNullStreams;
    let disposing: Promise<void> | undefined;
    const dispose = () =>
      (disposing ??= (async () => {
        try {
          child.stdin.destroy();
          const kill = (signal: NodeJS.Signals) => {
            // Trusted sandbox wrappers drain their contained group before exit;
            // never signal a numeric process group after that identity is reaped.
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
              if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
              else child.kill(signal);
            } catch {
              /* An already drained process has no group. */
            }
          };
          kill("SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 250));
          kill("SIGKILL");
          if (child.pid && child.exitCode === null && child.signalCode === null)
            await new Promise<void>((resolve) => {
              child.once("exit", () => resolve());
              child.once("error", () => resolve());
            });
          child.stdout.destroy();
          child.stderr.destroy();
        } finally {
          try {
            await prepared.dispose();
          } finally {
            await workspace.dispose();
          }
        }
      })());
    // Spawn errors can arrive before the transport attaches its observers.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error) => {
      await dispose();
      throw error;
    });
    let firstRequest = true;
    return {
      child,
      dispose,
      beforeRequest: async () => {
        // Startup belongs to the authorized connection effect. Its writes are
        // included in the first handshake response instead of discarded.
        if (firstRequest) {
          firstRequest = false;
          return;
        }
        await workspace.refresh();
      },
      beforeResponse: () => workspace.commit(),
    };
  });
}
