import type { ToolRegistry } from "@vcli/core";
import { type ToolDefinition } from "@vcli/core";
import { objectSchema, stringSchema } from "./schema.ts";
import type { BuiltinOptions } from "./types.ts";

type DiscoveryOptions = Pick<BuiltinOptions, "discover" | "skillList">;

export function createDiscoveryTool(
  registry: ToolRegistry,
  options: DiscoveryOptions,
): ToolDefinition {
  return {
    name: "tools_search",
    description:
      "Discover extension/MCP tools or skills by intent. Matching tool schemas become available on the next turn; skill bodies load only via skills_load.",
    kind: "read",
    inputSchema: objectSchema({ query: stringSchema }, ["query"]),
    async execute(args, context) {
      const query = String(args.query);
      await options.discover?.(query, context.signal, context);
      context.signal.throwIfAborted();

      const matches = registry.search(query);
      registry.activate(matches.map((tool) => tool.name));

      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      const skills = (options.skillList?.() ?? [])
        .filter((skill) =>
          words.some((word) => `${skill.name} ${skill.description}`.toLowerCase().includes(word)),
        )
        .slice(0, 10);
      if (skills.length) registry.activate(["skills_load"]);

      return {
        text: JSON.stringify({
          tools: matches.map((tool) => ({ name: tool.name, description: tool.description })),
          skills,
        }),
      };
    },
  };
}

export function createSkillsTool(loadSkill: BuiltinOptions["loadSkill"]): ToolDefinition {
  return {
    name: "skills_load",
    description:
      "Load full instructions for an explicitly selected skill; discover metadata with tools_search.",
    kind: "read",
    eager: false,
    inputSchema: objectSchema({ name: stringSchema }, ["name"]),
    async execute(args) {
      if (!loadSkill) throw new Error("No skills configured");
      return { text: await loadSkill(String(args.name)) };
    },
  };
}
