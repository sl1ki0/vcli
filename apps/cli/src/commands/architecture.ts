import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { layoutGraph, rasterize, renderSvg } from "@vcli/architecture";
import { print, printTree } from "../io.ts";
import { interactive } from "../interactive.ts";
import type { CommandContext } from "./context.ts";
import { configOverrides } from "../args.ts";
export async function architectureCommand(
  action: string | undefined,
  rest: string[],
  context: CommandContext,
) {
  const { root, config, architecture, values } = context;

  const graph = await architecture.scan(root);
  if (action === "scan" || !action)
    await print(
      values.json
        ? graph
        : `${printTree(graph)}\nParsed ${graph.stats.parsed}; cached ${graph.stats.cached}; ${Math.round(graph.stats.durationMs)} ms.`,
    );
  else if (action === "check") {
    const drift = architecture.check(graph, await architecture.readDesign(root));
    await print(
      values.json
        ? drift
        : drift.map((d) => d.message).join("\n") || "No declared architecture drift.",
    );
    if (drift.length) process.exitCode = 1;
  } else if (action === "export") {
    const format = values.format ?? "svg";
    if (!["svg", "png", "json"].includes(format))
      throw new Error("format must be svg, png, or json");
    const output = resolve(root, values.output ?? `architecture.${format}`);
    const content =
      format === "json" ? JSON.stringify(graph, null, 2) : renderSvg(await layoutGraph(graph));
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, format === "png" ? rasterize(content) : content);
    await print(`Exported ${output}`);
  } else if (action === "view")
    await interactive(root, config, architecture, graph, { overrides: configOverrides(values) });
  else throw new Error("Unknown architecture command");
  return;
}
