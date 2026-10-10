import type { ToolCall, ToolResult } from "./contracts.ts";

/** Keeps only line coordinates and retrieval handles, never copies source bodies. */
export class SourceReadCache {
  private readonly files = new Map<string, { revision: string; lines: Map<number, string> }>();
  clear(): void {
    this.files.clear();
  }
  deduplicate(call: ToolCall, result: ToolResult, artifact: string): string {
    let content = result.text;
    const full = result.fullOutput ?? result.text;
    const details = result.details as { sourcePath?: string; revision?: string } | undefined;
    if (
      call.name === "files_read" &&
      details?.sourcePath &&
      details.revision &&
      result.fullOutput
    ) {
      let known = this.files.get(details.sourcePath);
      if (!known || known.revision !== details.revision) {
        known = { revision: details.revision, lines: new Map() };
        this.files.set(details.sourcePath, known);
      }
      const fresh: string[] = [];
      const prior = new Set<string>();
      for (const line of full.split("\n")) {
        const number = Number(line.match(/^(\d+): /)?.[1]);
        if (!number) {
          fresh.push(line);
          continue;
        }
        const handle = known.lines.get(number);
        if (handle) prior.add(handle);
        else fresh.push(line);
        known.lines.set(number, artifact);
      }
      if (prior.size)
        content = `${details.sourcePath}\n${fresh.join("\n")}\nUnchanged overlapping lines omitted; earlier artifacts: ${[...prior].slice(0, 8).join(", ")}. Retrieve this result for the complete requested span.`;
    }

    return content;
  }
}
