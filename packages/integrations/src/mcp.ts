import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { NormalizedMcpServer, ToolDefinition, ToolResult } from "@vcli/core";
import { message, validateServerName } from "./paths.ts";
import { validateMcpInputSchema } from "./mcp-schema.ts";

export interface McpConnection {
  listTools(signal?: AbortSignal): Promise<Tool[]>;
  callTool(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  listResources(signal?: AbortSignal): Promise<Resource[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
  close(): Promise<void>;
}
export type McpConnector = (
  server: NormalizedMcpServer,
  signal?: AbortSignal,
) => Promise<McpConnection>;
export interface McpManagerOptions {
  connector?: McpConnector;
  timeoutMs?: number;
  resultChars?: number;
  /** Hard cap on decoded wire bodies and aggregated discovery lists. */
  maxResponseBytes?: number;
  onDiagnostic?: (text: string) => void;
}

const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Cap decoded HTTP bytes before SDK JSON/SSE parsing or error-body buffering. */
function boundedFetch(maxBytes: number, onLimit: (error: Error) => void): typeof fetch {
  return (async (input, init) => {
    const response = await fetch(input, init);
    if (!response.body) return response;
    const tooLarge = () => {
      const error = new Error(`MCP response exceeded ${maxBytes} bytes`);
      onLimit(error);
      return error;
    };
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) {
            controller.error(tooLarge());
            await reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("MCP request cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function toolName(server: string, name: string): string {
  const source = `${server}:${name}`;
  const prefix = `mcp_${server}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
  // The hash preserves identity when vendor/server namespaces normalize to the same characters.
  return `${prefix.slice(0, 51)}_${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

function bounded(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Output shortened; complete result retained as an artifact.]`;
}

/** Keeps images/binary content out of the model-facing text while retaining the exact result. */
export function mcpResult(result: CallToolResult | ReadResourceResult, limit = 8000): ToolResult {
  const fullOutput = JSON.stringify(result);
  const parts: string[] = [];
  if ("structuredContent" in result && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  const call = result as CallToolResult;
  if (Array.isArray(call.content)) {
    for (const item of call.content) {
      if (item.type === "text" && !parts.includes(item.text)) parts.push(item.text);
      else if (item.type === "resource_link")
        parts.push(
          `Resource: ${item.name} (${item.uri})${item.description ? ` — ${item.description}` : ""}`,
        );
      else if (item.type === "image" || item.type === "audio")
        parts.push(`[${item.type}: ${item.mimeType}; stored in complete result]`);
      else if (item.type === "resource")
        parts.push(
          "text" in item.resource ? item.resource.text : `[binary resource: ${item.resource.uri}]`,
        );
    }
  } else {
    for (const content of (result as ReadResourceResult).contents)
      parts.push("text" in content ? content.text : `[binary resource: ${content.uri}]`);
  }
  return {
    text: bounded(parts.join("\n") || "MCP request completed.", limit),
    fullOutput,
    details: result,
    isError: typeof call.isError === "boolean" ? call.isError : false,
  };
}

function sdkConnector(options: McpManagerOptions): McpConnector {
  return async (server, signal) => {
    const timeout = options.timeoutMs ?? 15_000;
    const maxBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
    const client = new Client(
      { name: "vcli", version: "0.1.0" },
      {
        capabilities: {},
        jsonSchemaValidator: {
          // SDK output validators need the same per-tool schema namespace isolation as inputs.
          getValidator: (schema) => new AjvJsonSchemaValidator().getValidator(schema),
        },
        // Auto-negotiation launches a disposable stdio sibling and executes startup twice.
        versionNegotiation:
          server.type === "stdio"
            ? { mode: "legacy" }
            : {
                mode: "auto",
                probe: { timeoutMs: Math.min(timeout, 3000), maxRetries: 0 },
              },
        inputRequired: { autoFulfill: false },
        listMaxPages: 64,
      },
    );
    const transport =
      server.type === "stdio"
        ? new StdioClientTransport({
            command: server.command!,
            args: server.args,
            cwd: server.cwd,
            env: { ...getDefaultEnvironment(), ...server.env },
            stderr: "pipe",
            maxBufferSize: maxBytes,
          })
        : new StreamableHTTPClientTransport(new URL(server.url!), {
            requestInit: { headers: server.headers, redirect: "error" },
            fetch: boundedFetch(maxBytes, (error) => {
              options.onDiagnostic?.(`${server.name}: ${error.message}`);
              // SSE parsers can report a stream error without settling the pending RPC.
              void client.close().catch(() => undefined);
            }),
            redirectPolicy: "same-origin",
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
            onInsufficientScope: "throw",
            maxStepUpRetries: 0,
          });
    if (transport instanceof StdioClientTransport)
      transport.stderr?.on("data", (chunk) =>
        options.onDiagnostic?.(`${server.name}: ${String(chunk).slice(0, 4096)}`),
      );
    client.onerror = (error) => options.onDiagnostic?.(`${server.name}: ${error.message}`);
    try {
      await client.connect(transport, { signal, timeout });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    // Walk pages ourselves so individually bounded pages cannot form an oversized aggregate.
    const list = async <T>(
      method: "tools/list" | "resources/list",
      items: "tools" | "resources",
      signal?: AbortSignal,
    ): Promise<T[]> => {
      const output: T[] = [];
      let cursor: string | undefined;
      let bytes = 0;
      const cursors = new Set<string>();
      for (let page = 0; page < 64; page++) {
        const result = await client.request(
          { method, ...(cursor !== undefined ? { params: { cursor } } : {}) },
          { signal, timeout },
        );
        bytes += Buffer.byteLength(JSON.stringify(result));
        if (bytes > maxBytes) throw new Error(`MCP ${method} exceeded ${maxBytes} bytes`);
        output.push(...((result as unknown as Record<string, T[]>)[items] ?? []));
        const next = "nextCursor" in result ? result.nextCursor : undefined;
        if (next === undefined) return output;
        if (typeof next !== "string" || cursors.has(next))
          throw new Error(`MCP ${method} returned an invalid/repeated cursor`);
        cursors.add(next);
        cursor = next;
      }
      throw new Error(`MCP ${method} exceeded 64 pages`);
    };
    return {
      listTools: (signal) => list<Tool>("tools/list", "tools", signal),
      callTool: (tool, args, signal) =>
        client.callTool(
          { name: tool.name, arguments: args },
          { signal, timeout, toolDefinition: tool },
        ),
      listResources: (signal) => list<Resource>("resources/list", "resources", signal),
      readResource: (uri, signal) => client.readResource({ uri }, { signal, timeout }),
      close: () => client.close(),
    };
  };
}

/** Connections are created by discovery, never installation. Failed calls are never replayed. */
export class McpManager {
  readonly diagnostics: string[] = [];
  private readonly servers = new Map<string, NormalizedMcpServer>();
  private readonly connections = new Map<string, Promise<McpConnection>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly failed = new Set<string>();
  private readonly connector: McpConnector;
  constructor(
    servers: readonly NormalizedMcpServer[] = [],
    private readonly options: McpManagerOptions = {},
  ) {
    if (
      options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
    )
      throw new Error("MCP maxResponseBytes must be a positive safe integer");
    this.connector = options.connector ?? sdkConnector(options);
    for (const server of servers) {
      for (const name of server.name.split(".")) validateServerName(name);
      if (this.servers.has(server.name))
        throw new Error(`Duplicate MCP server namespace: ${server.name}`);
      if (server.type === "stdio" && !server.command)
        throw new Error(`MCP server ${server.name} needs a command`);
      if (server.type === "http" && !server.url)
        throw new Error(`MCP server ${server.name} needs a URL`);
      this.servers.set(server.name, server);
    }
  }

  private report(text: string): void {
    this.diagnostics.push(text);
    this.options.onDiagnostic?.(text);
  }

  private async connection(
    name: string,
    signal?: AbortSignal,
    reconnect = false,
  ): Promise<McpConnection> {
    signal?.throwIfAborted();
    const server = this.servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (this.failed.has(name) && !reconnect)
      throw new Error(
        `MCP ${name} disconnected; reconnect and inspect state before trying another call`,
      );
    if (reconnect) this.failed.delete(name);
    let promise = this.connections.get(name);
    if (!promise) {
      const controller = new AbortController();
      this.controllers.set(name, controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const opening = this.connector(server, combined);
      // A custom connector may finish after cancellation. Close that late result rather than leak it.
      opening.then(
        (connection) => {
          if (combined.aborted)
            void connection
              .close()
              .catch((error) => this.report(`MCP ${name} close: ${message(error)}`));
        },
        () => undefined,
      );
      promise = abortable(opening, combined);
      this.connections.set(name, promise);
      promise.catch(() => {
        if (this.connections.get(name) === promise) {
          this.connections.delete(name);
          this.controllers.delete(name);
          this.failed.add(name);
        }
      });
    }
    return abortable(promise, signal);
  }

  private toolDefinition(server: string, tool: Tool): ToolDefinition {
    return {
      name: toolName(server, tool.name),
      description: `${server}: ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      kind: "execute",
      eager: false,
      execute: async (args, context) => {
        const connection = await this.connection(server, context.signal);
        try {
          return mcpResult(
            await abortable(connection.callTool(tool, args, context.signal), context.signal),
            this.options.resultChars,
          );
        } catch (error) {
          await this.disconnect(server);
          throw new Error(
            `MCP ${server}/${tool.name} failed: ${message(error)}. The call was not replayed; inspect external state before retrying.`,
          );
        }
      },
    };
  }

  private resourceDefinitions(server: string): ToolDefinition[] {
    return [
      {
        name: toolName(server, "@resources.list"),
        description: `List resources available from MCP server ${server}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        kind: "execute",
        eager: false,
        execute: async (_, context) => {
          const resources = await this.listResources(server, context.signal);
          const fullOutput = JSON.stringify(resources);
          return { text: bounded(fullOutput, this.options.resultChars ?? 8000), fullOutput };
        },
      },
      {
        name: toolName(server, "@resources.read"),
        description: `Read a resource URI from MCP server ${server}`,
        inputSchema: {
          type: "object",
          properties: { uri: { type: "string", minLength: 1 } },
          required: ["uri"],
          additionalProperties: false,
        },
        kind: "execute",
        eager: false,
        execute: (args, context) => this.readResource(server, String(args.uri), context.signal),
      },
    ];
  }

  private async discoverServer(server: string, signal?: AbortSignal): Promise<ToolDefinition[]> {
    const connection = await this.connection(server, signal, true);
    const tools = await connection.listTools(signal);
    const seen = new Set<string>();
    const definitions: ToolDefinition[] = [];
    for (const tool of tools) {
      if (
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
        seen.has(tool.name) ||
        !tool.inputSchema ||
        typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema)
      ) {
        this.report(`MCP ${server}: skipped invalid/duplicate tool ${tool.name}`);
        continue;
      }
      seen.add(tool.name);
      try {
        validateMcpInputSchema(tool.inputSchema);
        if (tool.outputSchema) validateMcpInputSchema(tool.outputSchema);
      } catch (error) {
        this.report(
          `MCP ${server}: skipped unsupported schema for ${tool.name}: ${message(error)}`,
        );
        continue;
      }
      definitions.push(this.toolDefinition(server, tool));
    }
    return [...definitions, ...this.resourceDefinitions(server)];
  }

  async discover(serverName?: string, signal?: AbortSignal): Promise<ToolDefinition[]> {
    if (serverName && !this.servers.has(serverName))
      throw new Error(`Unknown MCP server: ${serverName}`);
    const names = serverName ? [serverName] : [...this.servers.keys()];
    const results = await Promise.allSettled(
      names.map((name) => this.discoverServer(name, signal)),
    );
    const output: ToolDefinition[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") output.push(...result.value);
      else this.report(`MCP ${names[index]} discovery failed: ${message(result.reason)}`);
    });
    signal?.throwIfAborted();
    return output;
  }

  async listResources(serverName: string, signal?: AbortSignal): Promise<Resource[]> {
    return (await this.connection(serverName, signal)).listResources(signal);
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<ToolResult> {
    return mcpResult(
      await (await this.connection(serverName, signal)).readResource(uri, signal),
      this.options.resultChars,
    );
  }

  async disconnect(serverName?: string): Promise<void> {
    const names = serverName ? [serverName] : [...this.connections.keys()];
    await Promise.all(
      names.map(async (name) => {
        const promise = this.connections.get(name);
        this.connections.delete(name);
        this.failed.add(name);
        this.controllers.get(name)?.abort(new Error(`MCP ${name} disconnected`));
        this.controllers.delete(name);
        if (promise)
          await (await promise.catch(() => undefined))
            ?.close()
            .catch((error) => this.report(`MCP ${name} close: ${message(error)}`));
      }),
    );
  }

  async reconnect(serverName: string, signal?: AbortSignal): Promise<ToolDefinition[]> {
    await this.disconnect(serverName);
    return this.discover(serverName, signal);
  }
}
