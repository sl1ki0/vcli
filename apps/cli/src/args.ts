import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.ts";
export function parseCliArgs() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      root: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      permission: { type: "string" },
      renderer: { type: "string" },
      project: { type: "boolean" },
      ref: { type: "string" },
      subdir: { type: "string" },
      marketplace: { type: "string" },
    },
  });
  return { values, positionals };
}
export type CliValues = ReturnType<typeof parseCliArgs>["values"];
export function configOverrides(values: CliValues): Partial<Config> {
  const overrides: Partial<Config> = {};
  for (const key of ["provider", "model", "permission", "renderer"] as const)
    if (values[key]) (overrides as Record<string, unknown>)[key] = values[key];
  if (values.endpoint) overrides.baseURL = values.endpoint;
  return overrides;
}
export async function resolveSettings(values: CliValues) {
  const root = resolve(values.root ?? process.cwd());
  const overrides = configOverrides(values);
  const config = await loadConfig(root, overrides);
  return { root, config };
}
