import type { ToolRegistry } from "@vcli/core";
import { type ToolDefinition } from "@vcli/core";
import { createArchitectureTools } from "./tools/architecture.ts";
import { createDiscoveryTool, createSkillsTool } from "./tools/discovery.ts";
import { fileTools } from "./tools/files.ts";
import { createArtifactTool, createLedgerTool } from "./tools/session.ts";
import { shellTool } from "./tools/shell.ts";
import type { BuiltinOptions } from "./tools/types.ts";
import { inspectionTools } from "./tools/inspection.ts";

export { executeProcess } from "./tools/process.ts";
export type { BuiltinOptions } from "./tools/types.ts";

export function registerBuiltins(registry: ToolRegistry, options: BuiltinOptions): void {
  const tools: ToolDefinition[] = [
    ...fileTools,
    ...inspectionTools,
    shellTool,
    ...createArchitectureTools(options.architecture),
    createDiscoveryTool(registry, options),
    createArtifactTool(options.store),
    createSkillsTool(options.loadSkill),
    createLedgerTool(options.record),
  ];

  for (const tool of tools) {
    registry.register({ ...tool, eager: tool.eager ?? true });
  }
}
