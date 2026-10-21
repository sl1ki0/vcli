import { expect, test } from "bun:test";
import { PermissionGate, ToolRegistry } from "@vcli/core";
import { McpManager } from "../src/mcp.ts";

test("discovered MCP resource operations retain external permission gates after a mode change", async () => {
  let externalReads = 0;
  const manager = new McpManager(
    [{ name: "fixture", type: "http", url: "https://fixture.invalid" }],
    {
      connector: async () => ({
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        listResources: async () => {
          externalReads++;
          return [];
        },
        readResource: async (uri) => {
          externalReads++;
          return { contents: [{ uri, text: "fixture" }] };
        },
        close: async () => {},
      }),
    },
  );
  const registry = new ToolRegistry();
  const permissions = new PermissionGate("yolo");
  try {
    const tools = await manager.discover();
    expect(tools).toHaveLength(2);
    for (const tool of tools) registry.register(tool);
    for (const mode of ["read-only", "ask"] as const) {
      permissions.setMode(mode);
      for (const tool of tools) {
        const args = tool.description.startsWith("Read") ? { uri: "fixture://resource" } : {};
        await expect(permissions.authorize(tool, args)).rejects.toThrow();
      }
    }
    expect(externalReads).toBe(0);
    permissions.setMode("yolo");
    for (const tool of tools) {
      const args = tool.description.startsWith("Read") ? { uri: "fixture://resource" } : {};
      await permissions.authorize(tool, args);
      await registry.execute(
        { id: tool.name, name: tool.name, arguments: args },
        {
          root: "/fixture",
          sessionId: "fixture",
          signal: new AbortController().signal,
        },
      );
    }
    expect(externalReads).toBe(2);
  } finally {
    await manager.disconnect();
  }
});
