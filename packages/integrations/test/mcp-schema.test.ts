import { expect, test } from "bun:test";
import { validateMcpInputSchema } from "../src/mcp-schema.ts";
import { McpManager } from "../src/index.ts";
import type { Tool } from "@modelcontextprotocol/client";

test("external schemas reject regex execution and recursive/nonlocal references before registration", async () => {
  const schemas: Tool["inputSchema"][] = [
    { type: "object", properties: { value: { type: "string", pattern: "^(a|a?)+$" } } },
    { type: "object", patternProperties: { "^(a|a?)+$": { type: "string" } } },
    { type: "object", properties: { next: { $ref: "#" } } },
    {
      type: "object",
      $defs: { node: { $ref: "#/$defs/node" } },
      properties: { next: { $ref: "#/$defs/node" } },
    },
    { type: "object", properties: { external: { $ref: "https://fixture.invalid/schema" } } },
    { type: "object", properties: { value: { type: "string", format: "untrusted-format" } } },
  ];
  const manager = new McpManager([{ name: "fixture", type: "stdio", command: "unused" }], {
    connector: async () => ({
      listTools: async () => [
        ...schemas.map((inputSchema, index) => ({ name: `unsafe${index}`, inputSchema })),
        { name: "unsafe_output", inputSchema: { type: "object" }, outputSchema: schemas[0] },
        {
          name: "safe",
          inputSchema: {
            type: "object",
            $defs: { item: { type: "string" } },
            properties: { value: { $ref: "#/$defs/item" } },
          },
        },
      ],
      callTool: async () => ({ content: [] }),
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      close: async () => {},
    }),
  });
  try {
    const tools = await manager.discover();
    expect(tools).toHaveLength(3);
    expect(tools[0]!.description).toBe("fixture: safe");
    expect(manager.diagnostics).toHaveLength(7);
    expect(manager.diagnostics.join("\n")).not.toContain("^(a|a?)+$");
  } finally {
    await manager.disconnect();
  }
});

test("external schema size, depth and graph work are bounded", () => {
  expect(() => validateMcpInputSchema({ type: "object", description: "x".repeat(65536) })).toThrow(
    "65536 bytes",
  );
  let deep: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 34; index++) deep = { type: "array", items: deep };
  expect(() => validateMcpInputSchema(deep)).toThrow("depth 32");
  expect(() =>
    validateMcpInputSchema({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 1100 }, (_, index) => [`field${index}`, { type: "string" }]),
      ),
    }),
  ).toThrow("1024 nodes");
  expect(() =>
    validateMcpInputSchema({
      type: "object",
      $defs: { "a/b": { type: "string" } },
      properties: { value: { $ref: "#/$defs/a~1b" } },
    }),
  ).not.toThrow();
  const definitions: Record<string, unknown> = { leaf: { type: "string" } };
  let previous = "leaf";
  for (let index = 0; index < 15; index++) {
    definitions[`node${index}`] = {
      allOf: [{ $ref: `#/$defs/${previous}` }, { $ref: `#/$defs/${previous}` }],
    };
    previous = `node${index}`;
  }
  expect(() =>
    validateMcpInputSchema({
      type: "object",
      $defs: definitions,
      properties: { value: { $ref: `#/$defs/${previous}` } },
    }),
  ).toThrow("1024 nodes");
});

test("external schemas cannot silently widen unsupported newer-dialect constraints", () => {
  for (const keyword of [
    "dependentRequired",
    "dependentSchemas",
    "prefixItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "minContains",
    "maxContains",
  ])
    expect(() => validateMcpInputSchema({ type: "object", [keyword]: {} })).toThrow(
      "unsupported by the host validator",
    );
  expect(() =>
    validateMcpInputSchema({
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      additionalProperties: false,
      required: ["value"],
    }),
  ).not.toThrow();
});
