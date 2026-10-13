import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

export interface RpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export function response(request: RpcRequest): Record<string, unknown> | undefined {
  if (request.id === undefined) return undefined;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
  if (request.method === "server/discover")
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Legacy fixture" } };
  if (request.method === "initialize")
    return result({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
    });
  if (request.method === "tools/list")
    return request.params?.cursor
      ? result({
          tools: [
            {
              name: "uncertain",
              description: "Drops after executing once",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        })
      : result({
          tools: [
            {
              name: "echo",
              description: "Echo input",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
          nextCursor: "second",
        });
  if (request.method === "tools/call") {
    if (request.params?.name === "uncertain" && process.env.COUNT_FILE) {
      writeFileSync(process.env.COUNT_FILE, "executed");
      process.exit(1);
    }
    return result({
      content: [{ type: "text", text: JSON.stringify(request.params?.arguments) }],
      isError: false,
    });
  }
  if (request.method === "resources/list")
    return result({
      resources: [{ uri: "fixture://report", name: "report", mimeType: "text/plain" }],
    });
  if (request.method === "resources/read")
    return result({
      contents: [
        { uri: "fixture://report", text: "Full resource content", mimeType: "text/plain" },
      ],
    });
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } };
}

if (import.meta.main) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const result = response(JSON.parse(line) as RpcRequest);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  });
}
