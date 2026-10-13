import {
  boundText,
  type ArchitectureDesign,
  type ArchitectureService,
  type ToolDefinition,
} from "@vcli/core";
import { objectSchema, stringSchema } from "./schema.ts";

const designSchema = objectSchema(
  {
    version: {
      type: "integer",
      const: 1,
      description: 'Schema version. Use the number 1, not the string "1".',
    },
    components: {
      type: "array",
      items: objectSchema(
        {
          id: stringSchema,
          label: stringSchema,
          paths: { type: "array", items: stringSchema },
          dependencies: { type: "array", items: stringSchema },
          forbiddenDependencies: { type: "array", items: stringSchema },
        },
        ["id", "label", "paths"],
      ),
    },
    decisions: { type: "array", items: stringSchema },
  },
  ["version", "components", "decisions"],
);

export function createArchitectureTools(architecture: ArchitectureService): ToolDefinition[] {
  return [
    {
      name: "architecture_preview",
      description:
        "Display a proposed component design without writing it. Available in plan mode; use architecture_propose in build mode to persist an accepted design.",
      kind: "read",
      eager: false,
      inputSchema: objectSchema({ design: designSchema }, ["design"]),
      async execute(args, context) {
        const design = args.design as unknown as ArchitectureDesign;
        const intended = architecture.intendedGraph(context.root, design);
        return {
          text: `Design preview: ${design.components.length} components; no source or design files changed.`,
          fullOutput: JSON.stringify(design),
          details: { design, intended },
        };
      },
    },
    {
      name: "architecture_query",
      description:
        "Inspect project modules/dependencies and intended design, focused on a path or component; no model call.",
      kind: "read",
      inputSchema: objectSchema({ query: stringSchema }, []),
      async execute(args, context) {
        const graph = await architecture.scan(context.root);
        const query = String(args.query ?? "").toLowerCase();
        const nodes = graph.nodes
          .filter(
            (node) =>
              !query || `${node.id} ${node.path} ${node.label}`.toLowerCase().includes(query),
          )
          .slice(0, 50);
        const ids = new Set(nodes.map((node) => node.id));
        const result = {
          revision: graph.revision,
          nodes,
          edges: graph.edges
            .filter((edge) => ids.has(edge.source) || ids.has(edge.target))
            .slice(0, 100),
          design: await architecture.readDesign(context.root),
          diagnostics: graph.diagnostics,
          cycles: graph.cycles,
        };
        const output = JSON.stringify(result);
        return { text: boundText(output, 4_000), fullOutput: output, details: result };
      },
    },
    {
      name: "architecture_propose",
      description:
        "Write the intended architecture before structural edits. Supply all existing components/decisions plus the change; preserve user constraints. dependencies is an allowlist if present.",
      kind: "write",
      inputSchema: objectSchema({ design: designSchema }, ["design"]),
      async execute(args, context) {
        const design = args.design as unknown as ArchitectureDesign;
        await architecture.writeDesign(context.root, design);
        return {
          text: `Intended architecture updated: ${design.components.length} components.`,
          details: { design, intended: architecture.intendedGraph(context.root, design) },
          changedPaths: [".vcli/architecture.json"],
        };
      },
    },
  ];
}
