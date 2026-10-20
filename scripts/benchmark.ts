import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createArchitectureService } from "@vcli/architecture";
import {
  balanced,
  boundText,
  BudgetContextPlanner,
  estimateTokens,
  repositoryMap,
  SYSTEM,
  ToolRegistry,
  type ArchitectureDesign,
  type ArchitectureGraph,
  type Message,
  type ModelRequest,
  type Session,
  type SessionStore,
  type ToolCall,
  type ToolContext,
} from "@vcli/core";
import { registerBuiltins } from "../apps/cli/src/builtin-tools.ts";
import { createPlanTools } from "../apps/cli/src/tools/plans.ts";

// No provider adapter is imported or called. The evidence recipes below are
// scripted retrieval, not a claim that a model independently found the answer.
const root = resolve(import.meta.dir, "..");
const extensionCount = 1_000;
const encoder = new TextEncoder();
const lex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const size = (value: string) => ({
  utf8Bytes: encoder.encode(value).length,
  estimatedTokens: estimateTokens(value),
});
type Size = ReturnType<typeof size>;
interface Source {
  path: string;
  content: string;
  lines: string[];
}
interface EvidenceCheck {
  label: string;
  path: string;
  needle: string;
}
interface Task {
  id: string;
  query: string;
  graphQuery: string;
  toolIntent: string;
  searches: { path: string; query: string }[];
  checks: EvidenceCheck[];
}
const tasks: Task[] = [
  {
    id: "visuals",
    query:
      "Explain the architecture graph rendering pipeline: deterministic layout, terminal image rasterization, bundled font and viewport hit testing.",
    graphQuery: "architecture",
    toolIntent: "architecture",
    searches: [
      {
        path: "packages/architecture/src",
        query:
          "elk.randomSeed|elk.edgeRouting|export.*layoutGraph|export.*renderSvg|export.*rasterize|loadSystemFonts|export.*hitTest|export.*viewportToScene",
      },
    ],
    checks: [
      {
        label: "Layout is deterministic",
        path: "packages/architecture/src/render.ts",
        needle: '"elk.randomSeed": "1"',
      },
      {
        label: "Orthogonal graph edges",
        path: "packages/architecture/src/render.ts",
        needle: '"elk.edgeRouting": "ORTHOGONAL"',
      },
      {
        label: "SVG scene renderer",
        path: "packages/architecture/src/render.ts",
        needle: "export function renderSvg",
      },
      {
        label: "PNG rasterizer and bundled font",
        path: "packages/architecture/src/render.ts",
        needle: "loadSystemFonts: false",
      },
      {
        label: "Viewport coordinate conversion",
        path: "packages/architecture/src/render.ts",
        needle: "x: point.x / viewport.zoom + viewport.x",
      },
      {
        label: "Rectangle hit testing",
        path: "packages/architecture/src/render.ts",
        needle: "point.x >= node.x",
      },
    ],
  },
  {
    id: "permissions",
    query:
      "Where is YOLO the default, and how do ask and read-only permission modes authorize or deny tool execution?",
    graphQuery: "core",
    toolIntent: "permissions",
    searches: [
      { path: "apps/cli/src", query: 'permission: "yolo"|permission must be yolo' },
      {
        path: "packages/core/src",
        query:
          "class PermissionGate|async authorize|this.mode ===|Read-only mode denies|Approval denied|await binding.save",
      },
    ],
    checks: [
      { label: "Default is YOLO", path: "apps/cli/src/config.ts", needle: 'permission: "yolo"' },
      {
        label: "Settings validate all three modes",
        path: "apps/cli/src/config.ts",
        needle: "permission must be yolo, ask, or read-only",
      },
      {
        label: "Read tools bypass approvals",
        path: "packages/core/src/tools.ts",
        needle: 'if (tool.kind === "read") return;',
      },
      {
        label: "YOLO bypasses approvals after policy validation",
        path: "packages/core/src/tools.ts",
        needle: 'if (this.mode === "yolo" && !force) return;',
      },
      {
        label: "Read-only denies mutations",
        path: "packages/core/src/tools.ts",
        needle: "Read-only mode denies",
      },
      {
        label: "Ask validates explicit approval decisions",
        path: "packages/core/src/tools.ts",
        needle: 'if (decision !== true && decision !== "always")',
      },
      {
        label: "Remembered approvals persist before execution",
        path: "packages/core/src/tools.ts",
        needle: "await binding.save();",
      },
    ],
  },
  {
    id: "extensions",
    query:
      "Explain how MCP tools and skill instructions are discovered lazily, how active schemas stay bounded, and why a failed MCP call is not replayed.",
    graphQuery: "integrations",
    toolIntent: "extensions",
    searches: [
      {
        path: "packages/core/src",
        query: "activate\\(|schemas\\(|candidates =|cost \\+ size <= budget",
      },
      { path: "apps/cli/src", query: "registry.activate|skills_load|tools_search" },
      {
        path: "packages/integrations/src",
        query: "Connections are created|async discover|callTool\\(tool|not replayed",
      },
    ],
    checks: [
      {
        label: "Inactive schemas excluded",
        path: "packages/core/src/tools.ts",
        needle: "this.active.has(t.name)",
      },
      {
        label: "Schema token ceiling",
        path: "packages/core/src/tools.ts",
        needle: "if (cost + size <= budget)",
      },
      {
        label: "Discovery activates matches",
        path: "apps/cli/src/tools/discovery.ts",
        needle: "registry.activate(matches.map",
      },
      {
        label: "Skill bodies load lazily",
        path: "apps/cli/src/tools/discovery.ts",
        needle: 'name: "skills_load"',
      },
      {
        label: "MCP connects on discovery",
        path: "packages/integrations/src/mcp.ts",
        needle: "Connections are created by discovery",
      },
      {
        label: "MCP tools initially inactive",
        path: "packages/integrations/src/mcp.ts",
        needle: "eager: false",
      },
      {
        label: "Failures explicitly are not replayed",
        path: "packages/integrations/src/mcp.ts",
        needle: "The call was not replayed",
      },
    ],
  },
];

function argumentsForRun() {
  const args = process.argv.slice(2);
  let iterations = 25;
  let output: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--iterations") iterations = Number(args[++i]);
    else if (args[i] === "--write") {
      const path = args[++i];
      if (!path) throw new Error("--write requires a Markdown path");
      output = resolve(root, path);
    } else if (args[i] === "--json") json = true;
    else if (args[i] === "--help") {
      console.log(
        "Offline context benchmark: bun run benchmark [--iterations 25] [--json] [--write docs/benchmarks.md]\nNo model requests, network calls, or paid APIs. Counts are deterministic for the recorded source hash; local timings vary.",
      );
      process.exit(0);
    } else throw new Error(`Unknown benchmark option: ${args[i]}`);
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000)
    throw new Error("--iterations must be an integer from 1 to 1000");
  return { iterations, output, json };
}

async function snapshot(): Promise<{
  graph: ArchitectureGraph;
  sources: Source[];
  firstScanMs: number;
  warmScanMs: number;
  sourceReadMs: number;
}> {
  const architecture = createArchitectureService();
  for (let attempt = 0; attempt < 3; attempt++) {
    let start = performance.now();
    const graph = await architecture.scan(root);
    const firstScanMs = performance.now() - start;
    const paths = [
      ...new Set(
        graph.nodes
          .filter(
            (node) =>
              node.kind === "module" &&
              node.path &&
              /^(apps|packages)\/[^/]+\/src\//.test(node.path),
          )
          .map((node) => node.path!),
      ),
    ].sort(lex);
    start = performance.now();
    const sources = await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(resolve(root, path), "utf8");
        return { path, content, lines: content.split("\n") };
      }),
    );
    const sourceReadMs = performance.now() - start;
    start = performance.now();
    const warm = await architecture.scan(root);
    const warmScanMs = performance.now() - start;
    if (graph.revision === warm.revision)
      return { graph: warm, sources, firstScanMs, warmScanMs, sourceReadMs };
  }
  throw new Error(
    "Repository source changed during three snapshot attempts; rerun after edits finish.",
  );
}

function registryFor(graph: ArchitectureGraph, design: ArchitectureDesign) {
  const registry = new ToolRegistry();
  const unavailable = async (): Promise<never> => {
    throw new Error("Not used by this read-only benchmark");
  };
  const store: SessionStore = {
    create: unavailable,
    get: unavailable,
    list: unavailable,
    save: unavailable,
    append: unavailable,
    putArtifact: unavailable,
    readArtifact: unavailable,
    pendingMutations: unavailable,
  };
  const architecture = createArchitectureService();
  // Reuse the fixed snapshot: architecture_query is measured independently of indexing.
  registerBuiltins(registry, {
    architecture: { ...architecture, scan: async () => graph, readDesign: async () => design },
    store,
  });
  for (const tool of createPlanTools({
    getSession: () => undefined,
    save: async () => {
      throw new Error("Offline schema fixture cannot save plans");
    },
  }))
    registry.register(tool);
  const categories = ["architecture", "permissions", "extensions", "build", "files"];
  for (let index = 0; index < extensionCount; index++) {
    const category = categories[index % categories.length]!;
    registry.register({
      name: `mcp_fixture_${category}_${String(index).padStart(4, "0")}`,
      description: `Synthetic ${category} extension tool ${index}. Inspect repository ${category} records by query and scoped path; return matching records, source locations, dependency summaries and a continuation cursor. This schema fixture measures discovery overhead and is never executed.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: `Search terms for ${category} records` },
          path: { type: "string", description: "Repository-relative scope" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor from an earlier result",
          },
          includeEvidence: { type: "boolean", default: true },
        },
        required: ["query"],
        additionalProperties: false,
      },
      kind: "read",
      eager: false,
      execute: unavailable,
    });
  }
  return registry;
}

function requestText(request: ModelRequest): string {
  // Exactly the estimator input used by AgentRuntime, before provider-specific wrappers.
  return request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools);
}

function measure<T>(
  iterations: number,
  operation: () => T,
): { value: T; medianMs: number; p95Ms: number } {
  for (let i = 0; i < 3; i++) operation();
  const samples: number[] = [];
  let value!: T;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    value = operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    value,
    medianMs: samples[Math.floor(samples.length / 2)]!,
    p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!,
  };
}

function sessionFor(task: Task, messages: Message[]): Session {
  return {
    id: "offline-benchmark",
    root,
    provider: "offline",
    model: "none",
    status: "running",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    messages,
    ledger: {
      goal: task.query,
      constraints: [],
      decisions: [],
      pending: [],
      touchedPaths: [],
      verification: [],
    },
    usage: { input: 0, output: 0, cached: 0 },
  };
}

function evidence(task: Task, sources: Source[], request: ModelRequest) {
  const blocks = request.messages.map((message) => message.text);
  return task.checks.map((check) => {
    const source = sources.find((source) => source.path === check.path);
    if (!source) throw new Error(`Missing evidence file ${check.path}`);
    const matches = source.lines.flatMap((line, index) =>
      line.includes(check.needle) ? [{ line, number: index + 1 }] : [],
    );
    if (!matches.length)
      throw new Error(`Evidence anchor changed: ${check.label}; update this benchmark recipe`);
    const found = blocks.some(
      (block) =>
        block.includes(check.path) &&
        matches.some((match) => block.includes(`${match.number}: ${match.line}`)),
    );
    return { label: check.label, path: check.path, line: matches[0]!.number, present: found };
  });
}

function mergeSpans(spans: { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1);
    if (prior && span.start <= prior.end + 1) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

async function runTask(
  task: Task,
  graph: ArchitectureGraph,
  design: ArchitectureDesign,
  sources: Source[],
  fullSource: string,
  iterations: number,
) {
  const context: ToolContext = {
    root,
    sessionId: "offline-benchmark",
    signal: new AbortController().signal,
  };
  let start = performance.now();
  const registry = registryFor(graph, design);
  const registrySetupMs = performance.now() - start;
  const allSchemas = registry.search("", extensionCount + 20);
  const eagerSchemas = registry.schemas(balanced.schemaTokens, true);
  const calls: ToolCall[] = [];
  const optimizedResults: Message[] = [];
  const baselineResults: Message[] = [];
  const rawResultTexts: string[] = [];
  const boundedResultTexts: string[] = [];
  async function execute(name: string, args: Record<string, unknown>) {
    const call: ToolCall = { id: `benchmark-call-${calls.length + 1}`, name, arguments: args };
    calls.push(call);
    const result = await registry.execute(call, context);
    if (result.isError) throw new Error(`${name}: ${result.text}`);
    const full = result.fullOutput ?? result.text;
    const artifact = `benchmark-artifact:${digest(full).slice(0, 16)}`;
    const sourcePath = (result.details as { sourcePath?: string } | undefined)?.sourcePath;
    const prefix = sourcePath ? `${relative(root, sourcePath).replaceAll("\\", "/")}\n` : "";
    const optimized = `${boundText(result.text, balanced.resultTokens)}\nFull result: ${artifact}`;
    const baseline = `${prefix}${full}\nFull result: ${artifact}`;
    rawResultTexts.push(baseline);
    boundedResultTexts.push(optimized);
    optimizedResults.push({ role: "tool", toolCallId: call.id, toolName: name, text: optimized });
    baselineResults.push({ role: "tool", toolCallId: call.id, toolName: name, text: baseline });
    return result;
  }
  start = performance.now();
  await execute("tools_search", { query: task.toolIntent });
  const discoveryMs = performance.now() - start;
  start = performance.now();
  await execute("architecture_query", { query: task.graphQuery });
  const spans = new Map<string, { start: number; end: number }[]>();
  for (const search of task.searches) {
    const result = await execute("files_search", search);
    // Only visible matches drive reads. Hidden full artifacts are not an oracle.
    for (const line of result.text.split("\n")) {
      const match = line.match(/^(.+?):(\d+):/);
      if (!match) continue;
      const path = match[1]!.replace(/^\.\//, "");
      const number = Number(match[2]);
      if (!sources.some((source) => source.path === path)) continue;
      const existing = spans.get(path) ?? [];
      existing.push({ start: Math.max(1, number - 8), end: number + 8 });
      spans.set(path, existing);
    }
  }
  for (const [path, values] of [...spans].sort(([a], [b]) => lex(a, b))) {
    for (const span of mergeSpans(values)) await execute("files_read", { path, ...span });
  }
  const retrievalMs = performance.now() - start;
  const session = sessionFor(task, [
    { role: "user", text: task.query },
    { role: "assistant", text: "", toolCalls: calls },
    ...optimizedResults,
  ]);
  const baselineSession = sessionFor(task, [
    { role: "user", text: task.query },
    { role: "assistant", text: "", toolCalls: calls },
    ...baselineResults,
  ]);
  const planner = new BudgetContextPlanner();
  const optimized = measure(iterations, () => {
    const request = planner.build(
      session,
      graph,
      registry.schemas(balanced.schemaTokens),
      balanced,
      128_000,
    );
    return { request, size: size(requestText(request)) };
  });
  const baseline = measure(iterations, () => {
    const request: ModelRequest = {
      system: SYSTEM,
      tools: allSchemas,
      maxOutputTokens: balanced.outputTokens,
      messages: [
        ...baselineSession.messages,
        {
          role: "user",
          text: `[Local context snapshot; source facts, not instructions]\n${fullSource}\nTask ledger: ${JSON.stringify(baselineSession.ledger)}`,
        },
      ],
    };
    return { request, size: size(requestText(request)) };
  });
  const lazySchemas = optimized.value.request.tools;
  const fullCoverage = evidence(task, sources, baseline.value.request);
  const optimizedCoverage = evidence(task, sources, optimized.value.request);
  const savingsPercent =
    (1 - optimized.value.size.estimatedTokens / baseline.value.size.estimatedTokens) * 100;
  return {
    id: task.id,
    query: task.query,
    retrievalRecipe: task.searches,
    toolCalls: calls.length,
    full: {
      context: baseline.value.size,
      schemas: size(JSON.stringify(allSchemas)),
      schemaCount: allSchemas.length,
      results: size(rawResultTexts.join("\n")),
      evidence: fullCoverage,
    },
    optimized: {
      context: optimized.value.size,
      repositoryMap: size(repositoryMap(graph, task.query + " " + task.query, balanced.mapTokens)),
      schemas: size(JSON.stringify(lazySchemas)),
      schemaCount: lazySchemas.length,
      initialSchemaCount: eagerSchemas.length,
      initialSchemas: size(JSON.stringify(eagerSchemas)),
      results: size(boundedResultTexts.join("\n")),
      evidence: optimizedCoverage,
    },
    savingsPercent,
    localLatencyMs: {
      registrySetup: registrySetupMs,
      discovery: discoveryMs,
      retrieval: retrievalMs,
      fullAssemblyMedian: baseline.medianMs,
      fullAssemblyP95: baseline.p95Ms,
      optimizedAssemblyMedian: optimized.medianMs,
      optimizedAssemblyP95: optimized.p95Ms,
    },
  };
}

type TaskResult = Awaited<ReturnType<typeof runTask>>;
interface Report {
  version: 1;
  measuredAt: string;
  sourceHash: string;
  designHash: string;
  gitRevision: string;
  graphRevision: string;
  sourceFiles: number;
  rawSource: Size;
  numberedSource: Size;
  environment: { bun: string; os: string; architecture: string; cpu: string };
  iterations: number;
  extensionSchemas: number;
  localSnapshotMs: { firstScan: number; warmScan: number; readSources: number };
  warmCache: { parsed: number; cached: number };
  budgets: typeof balanced;
  tasks: TaskResult[];
}
const number = (value: number) => value.toLocaleString("en-US");
const ms = (value: number) => value.toFixed(2);
const coverage = (checks: { present: boolean }[]) =>
  `${checks.filter((check) => check.present).length}/${checks.length}`;
function markdown(report: Report): string {
  const rows = report.tasks
    .map(
      (task) =>
        `| ${task.id} | ${number(task.full.context.estimatedTokens)} | ${number(task.optimized.context.estimatedTokens)} | ${task.savingsPercent.toFixed(1)}% | ${coverage(task.full.evidence)} → ${coverage(task.optimized.evidence)} |`,
    )
    .join("\n");
  const breakdown = report.tasks
    .map(
      (task) =>
        `| ${task.id} | ${number(task.optimized.repositoryMap.estimatedTokens)} | ${number(task.full.schemas.estimatedTokens)} → ${number(task.optimized.schemas.estimatedTokens)} | ${number(task.full.results.estimatedTokens)} → ${number(task.optimized.results.estimatedTokens)} | ${task.optimized.initialSchemaCount} → ${task.optimized.schemaCount} / ${task.full.schemaCount} |`,
    )
    .join("\n");
  const latency = report.tasks
    .map(
      (task) =>
        `| ${task.id} | ${ms(task.localLatencyMs.discovery)} | ${ms(task.localLatencyMs.retrieval)} | ${ms(task.localLatencyMs.fullAssemblyMedian)} / ${ms(task.localLatencyMs.fullAssemblyP95)} | ${ms(task.localLatencyMs.optimizedAssemblyMedian)} / ${ms(task.localLatencyMs.optimizedAssemblyP95)} |`,
    )
    .join("\n");
  const evidenceRows = report.tasks
    .flatMap((task) =>
      task.optimized.evidence.map(
        (check) =>
          `| ${task.id} | ${check.label} | [${check.path}:${check.line}](../${check.path}#L${check.line}) | ${check.present ? "present" : "missing"} |`,
      ),
    )
    .join("\n");
  return `# Offline context benchmark

Measured ${report.measuredAt}. This benchmark measures prompt size, local preparation time and source evidence presence. **No model requests or paid APIs were called.** It does not measure task completion, answer accuracy, retries, total session tokens, provider tokenization, cached-token billing or remote model latency.

## Reproduce

\`bun run benchmark --write docs/benchmarks.md\`

Use \`--json\` for the full machine-readable report and \`--iterations 50\` to change assembly timing samples. The default is 25 samples after three warmups. Source edits change results; timing varies with the machine and cache. The script rejects a changing source snapshot and fails if a checked evidence line disappears from the optimized prompt. It imports no provider adapter and has no live-provider option.

## Fixture and method

- Production source corpus: ${report.sourceFiles} module files under \`apps/*/src\` and \`packages/*/src\`, with tests, build scripts, dependencies, binaries and documentation excluded. Raw source is ${number(report.rawSource.utf8Bytes)} UTF-8 bytes (${number(report.rawSource.estimatedTokens)} estimated tokens).
- Source SHA-256: \`${report.sourceHash}\`. Git HEAD: \`${report.gitRevision}\`; source hash is authoritative because the working tree can contain changes. Graph revision: \`${report.graphRevision}\`; intended-design SHA-256: \`${report.designHash}\`. These capture the repository inputs separately from the scripted tool fixture.
- Environment: Bun ${report.environment.bun}, ${report.environment.os}, ${report.environment.architecture}, ${report.environment.cpu}.
- Schema fixture: exactly ${number(report.extensionSchemas)} deterministic **synthetic** extension schemas across five categories, plus actual built-in schemas. The fixtures represent a large catalog and are never executed. They are not a measurement of an installed marketplace or real MCP server.
- Both paths receive each identical task question, the same system instruction, ledger, tool-call recipe and retrieved source. Full context injects every production source file with numbered lines, every schema and complete tool results. Optimized context calls actual \`repositoryMap\`, \`boundText\`, \`BudgetContextPlanner\`, \`ToolRegistry\` and built-in tools, activates up to five search matches, and includes scoped reads around visible search matches. There is no model-driven retrieval here: search patterns and starting paths are scripted and published in the JSON report.
- The optimized budgets are the CLI's balanced defaults: ${number(report.budgets.promptTokens)} prompt, ${number(report.budgets.mapTokens)} map, ${number(report.budgets.schemaTokens)} schemas and ${number(report.budgets.resultTokens)} tokens per result. Stored-artifact references are deterministic handles; this benchmark retains full outputs in memory and does not create an agent session.
- Estimated tokens use the runtime's \`ceil(UTF8 bytes / 3)\` heuristic. Total context counts \`system + JSON.stringify(messages) + JSON.stringify(tools)\`, matching the runtime estimate before provider wrappers. Component sizes are measured separately, so JSON escaping and rounding mean columns do not sum exactly. These are estimates, not billed token counts.

## Measured prompt size

| Identical task | Full estimated tokens | Optimized estimated tokens | Reduction | Checked evidence, full → optimized |
| --- | ---: | ---: | ---: | ---: |
${rows}

The full-schema stress baseline may exceed a model's context window. The percentages describe these particular prepared prompts, not universal savings or equivalent model outcomes. They include the deliberately large synthetic catalog; the component table separates its contribution from repository context and bounded results.

| Task | Repository map estimated tokens | Schemas, full → lazy | Tool results, full → bounded | Exposed schemas, initial → discovered / catalog |
| --- | ---: | ---: | ---: | ---: |
${breakdown}

The full numbered source snapshot is ${number(report.numberedSource.utf8Bytes)} UTF-8 bytes (${number(report.numberedSource.estimatedTokens)} estimated tokens); the raw-source count above excludes file headings and line labels. Scoped reads still carry the implementation lines needed to assess the task, while the map contributes module signatures and relations.

## Local latency

Both assembly measurements start with the same source, graph, schema and retrieval data in memory. Each sample includes context construction, schema selection where applicable, JSON serialization and the UTF-8 estimate. They exclude disk access, tool execution, provider serialization and network/model time. Discovery and retrieval are separately observed once per task; they are not summed into a claimed end-to-end speedup.

| Task | Discovery ms | Retrieval ms | Full assembly median / p95 ms | Optimized assembly median / p95 ms |
| --- | ---: | ---: | ---: | ---: |
${latency}

Snapshot preparation: first observed scan ${ms(report.localSnapshotMs.firstScan)} ms, warm verification scan ${ms(report.localSnapshotMs.warmScan)} ms, source reads ${ms(report.localSnapshotMs.readSources)} ms. The first scan may already have a persisted cache; it is **not a cold-scan benchmark**. The warm scan parsed ${report.warmCache.parsed} files and reused ${report.warmCache.cached}. Registering/validating the 1,000-schema fixture took ${report.tasks.map((task) => `${task.id}: ${ms(task.localLatencyMs.registrySetup)} ms`).join("; ")}, excluded from prompt assembly timings.

## Evidence coverage

Coverage means a known repository path and its exact numbered implementation line survive in a model-facing message. It does not evaluate an answer or prove every fact required for a complete implementation is present. The checks are explicit source anchors, not signatures alone; the full baseline naturally contains them because it includes all source. Search matches, not these checks, drive the scoped reads.

| Task | Checked fact | Source line | Optimized prompt |
| --- | --- | --- | --- |
${evidenceRows}

## What remains unmeasured

A live comparison would need repeated identical tasks, fixed provider/model versions, actual usage records, completion/verification scoring, retry counts and total request latency. This offline run provides none of those results. In particular it cannot establish that a smaller initial prompt saves total task tokens if a model needs additional searches or retries. No real marketplace discovery, MCP connection startup or terminal graphics latency is included.
`;
}

async function main() {
  const options = argumentsForRun();
  const captured = await snapshot();
  const design = await createArchitectureService().readDesign(root);
  const fullSource = captured.sources
    .map(
      (source) =>
        `File: ${source.path}\n${source.lines.map((line, index) => `${index + 1}: ${line}`).join("\n")}`,
    )
    .join("\n\n");
  const sourceHash = digest(
    captured.sources.map((source) => `${source.path}\0${source.content}`).join("\0"),
  );
  const measured = [];
  for (const task of tasks)
    measured.push(
      await runTask(task, captured.graph, design, captured.sources, fullSource, options.iterations),
    );
  const stable = await createArchitectureService().scan(root);
  if (stable.revision !== captured.graph.revision)
    throw new Error("Source changed during retrieval; rerun after edits finish.");
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  const report: Report = {
    version: 1,
    measuredAt: new Date().toISOString(),
    sourceHash,
    designHash: digest(JSON.stringify(design)),
    gitRevision: revision.exitCode === 0 ? revision.stdout.toString().trim() : "unavailable",
    graphRevision: captured.graph.revision,
    sourceFiles: captured.sources.length,
    rawSource: size(captured.sources.map((source) => source.content).join("\n")),
    numberedSource: size(fullSource),
    environment: {
      bun: Bun.version,
      os: `${platform()} ${release()}`,
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
    },
    iterations: options.iterations,
    extensionSchemas: extensionCount,
    budgets: balanced,
    tasks: measured,
    localSnapshotMs: {
      firstScan: captured.firstScanMs,
      warmScan: captured.warmScanMs,
      readSources: captured.sourceReadMs,
    },
    warmCache: { parsed: captured.graph.stats.parsed, cached: captured.graph.stats.cached },
  };
  if (measured.some((task) => task.optimized.evidence.some((check) => !check.present))) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error("Checked evidence was omitted from the optimized context");
  }
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    const { format, resolveConfig } = await import("prettier");
    const formatting = await resolveConfig(options.output);
    await writeFile(
      options.output,
      await format(markdown(report), { ...formatting, parser: "markdown" }),
    );
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Offline benchmark: ${report.sourceFiles} production files; ${extensionCount} synthetic extension schemas; UTF-8 token estimates, no model calls.`,
    );
    for (const task of measured)
      console.log(
        `${task.id}: ${number(task.full.context.estimatedTokens)} → ${number(task.optimized.context.estimatedTokens)} estimated tokens (${task.savingsPercent.toFixed(1)}% less); evidence ${coverage(task.optimized.evidence)}; assembly ${ms(task.localLatencyMs.fullAssemblyMedian)} → ${ms(task.localLatencyMs.optimizedAssemblyMedian)} ms median`,
      );
    if (options.output) console.log(`Published ${relative(root, options.output)}`);
  }
}
await main();
