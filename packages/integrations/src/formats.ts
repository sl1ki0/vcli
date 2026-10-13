import type { PluginEcosystem } from "@vcli/core";

/** Format rules describe an ecosystem, never an individual plugin or marketplace. */
export interface PluginFormat {
  readonly id: PluginEcosystem;
  readonly manifest: string;
  readonly mcpFile: string;
  readonly legacyUrl?: boolean;
  readonly contextFile?: string;
}

export const pluginFormats: readonly PluginFormat[] = Object.freeze(
  (
    [
      { id: "portable", manifest: "plugin.json", mcpFile: "mcp.json" },
      { id: "claude", manifest: ".claude-plugin/plugin.json", mcpFile: ".mcp.json" },
      { id: "codex", manifest: ".codex-plugin/plugin.json", mcpFile: ".mcp.json" },
      {
        id: "gemini",
        manifest: "gemini-extension.json",
        mcpFile: ".mcp.json",
        legacyUrl: true,
        contextFile: "GEMINI.md",
      },
      {
        id: "qwen",
        manifest: "qwen-extension.json",
        mcpFile: ".mcp.json",
        legacyUrl: true,
        contextFile: "QWEN.md",
      },
      {
        id: "qoder",
        manifest: ".qoder-plugin/plugin.json",
        mcpFile: ".mcp.json",
        contextFile: "system-prompt.md",
      },
    ] satisfies PluginFormat[]
  ).map((format) => Object.freeze(format)),
);

export function pluginFormat(id: string): PluginFormat {
  const format = pluginFormats.find((format) => format.id === id);
  if (!format)
    throw new Error(
      `Unknown plugin format ${id}; choose ${pluginFormats.map((f) => f.id).join(", ")}`,
    );
  return format;
}

export const vendorComponentFields = [
  "commands",
  "agents",
  "skills",
  "hooks",
  "outputStyles",
  "themes",
] as const;
