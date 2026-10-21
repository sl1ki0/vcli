import type { NormalizedMcpServer } from "@vcli/core";

/** Validate every entry point, including raw user/project configuration. */
export function validateMcpHttpUrl(value: unknown): URL {
  if (typeof value !== "string" || !value || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error("MCP HTTP URL must be a nonempty HTTP(S) URL without whitespace");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP HTTP URL must be an absolute HTTP(S) URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("MCP HTTP URL must use HTTP(S) without credentials or a fragment");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("MCP non-local HTTP endpoint must use HTTPS");
  return url;
}

function strings(value: unknown, label: string): asserts value is Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, item]) => !key || typeof item !== "string" || /\0/.test(key + item),
    )
  )
    throw new Error(`MCP ${label} must be an object of strings without NUL bytes`);
}

export function validateMcpServer(value: unknown): asserts value is NormalizedMcpServer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP server must be an object");
  const server = value as Record<string, unknown>;
  if (
    typeof server.name !== "string" ||
    !server.name.split(".").every((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part))
  )
    throw new Error("MCP server name must contain nonempty valid namespace segments");
  if (server.type === "http") {
    validateMcpHttpUrl(server.url);
    for (const key of ["command", "args", "cwd", "env"])
      if (server[key] !== undefined) throw new Error(`MCP HTTP server cannot specify ${key}`);
    if (server.headers !== undefined) {
      strings(server.headers, "headers");
      const names = new Set<string>();
      for (const [key, item] of Object.entries(server.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item))
          throw new Error("MCP HTTP server has an invalid header");
        if (names.has(key.toLowerCase())) throw new Error("MCP HTTP server has duplicate headers");
        names.add(key.toLowerCase());
      }
    }
  } else if (server.type === "stdio") {
    if (typeof server.command !== "string" || !server.command || /[\r\n\0]/.test(server.command))
      throw new Error("MCP stdio server needs one executable command");
    if (
      server.args !== undefined &&
      (!Array.isArray(server.args) ||
        server.args.some((item) => typeof item !== "string" || /\0/.test(item)))
    )
      throw new Error("MCP stdio args must be an array of strings without NUL bytes");
    if (
      server.cwd !== undefined &&
      (typeof server.cwd !== "string" || !server.cwd || /\0/.test(server.cwd))
    )
      throw new Error("MCP stdio cwd must be a nonempty string without NUL bytes");
    if (server.env !== undefined) strings(server.env, "environment");
    if (server.url !== undefined || server.headers !== undefined)
      throw new Error("MCP stdio server cannot specify HTTP configuration");
  } else throw new Error("MCP server type must be stdio or http");
}
