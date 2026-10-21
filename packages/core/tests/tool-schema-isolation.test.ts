import { expect, test } from "bun:test";
import { ToolRegistry, type ToolDefinition } from "../src/index.ts";

test("tool-local schema IDs and invalid registrations cannot poison other tool validators", () => {
  const registry = new ToolRegistry();
  const definition = (name: string, type: string): ToolDefinition => ({
    name,
    description: "Fixture",
    kind: "execute",
    inputSchema: {
      $id: "https://fixture.invalid/shared.schema.json",
      type: "object",
      properties: { value: { type } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async () => ({ text: "Fixture" }),
  });
  expect(() => registry.register(definition("broken", "unsupported-type"))).toThrow();
  registry.register(definition("text", "string"));
  registry.register(definition("number", "number"));
  registry.register(definition("broken", "boolean"));
  expect(registry.validate({ id: "one", name: "text", arguments: { value: "ok" } }).name).toBe(
    "text",
  );
  expect(registry.validate({ id: "two", name: "number", arguments: { value: 42 } }).name).toBe(
    "number",
  );
  expect(registry.validate({ id: "three", name: "broken", arguments: { value: true } }).name).toBe(
    "broken",
  );
  expect(() =>
    registry.validate({ id: "four", name: "number", arguments: { value: "42" } }),
  ).toThrow();
});
