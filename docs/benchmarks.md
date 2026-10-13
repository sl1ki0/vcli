# Offline context benchmark

Measured 2026-10-13T16:30:22.936Z. This benchmark measures prompt size, local preparation time and source evidence presence. **No model requests or paid APIs were called.** It does not measure task completion, answer accuracy, retries, total session tokens, provider tokenization, cached-token billing or remote model latency.

## Reproduce

`bun run benchmark --write docs/benchmarks.md`

Use `--json` for the full machine-readable report and `--iterations 50` to change assembly timing samples. The default is 25 samples after three warmups. Source edits change results; timing varies with the machine and cache. The script rejects a changing source snapshot and fails if a checked evidence line disappears from the optimized prompt. It imports no provider adapter and has no live-provider option.

## Fixture and method

- Production source corpus: 108 module files under `apps/*/src` and `packages/*/src`, with tests, build scripts, dependencies, binaries and documentation excluded. Raw source is 455,389 UTF-8 bytes (151,797 estimated tokens).
- Source SHA-256: `1149e23d2e8bab0296aebad640ad0e6d840bb153ae83df50ea0765feca37bef7`. Git HEAD: `9f10dbf956dbbdbc7150813971aaf25a8f9ec010`; source hash is authoritative because the working tree can contain changes. Graph revision: `977a5399c6ec905dddb2`; intended-design SHA-256: `69f506c0308d0010bffc2b2f2e6572053804d03d059524a2d19349396cfa9091`. These capture the repository inputs separately from the scripted tool fixture.
- Environment: Bun 1.3.13, darwin 24.6.0, arm64, Apple M4.
- Schema fixture: exactly 1,000 deterministic **synthetic** extension schemas across five categories, plus actual built-in schemas. The fixtures represent a large catalog and are never executed. They are not a measurement of an installed marketplace or real MCP server.
- Both paths receive each identical task question, the same system instruction, ledger, tool-call recipe and retrieved source. Full context injects every production source file with numbered lines, every schema and complete tool results. Optimized context calls actual `repositoryMap`, `boundText`, `BudgetContextPlanner`, `ToolRegistry` and built-in tools, activates up to five search matches, and includes scoped reads around visible search matches. There is no model-driven retrieval here: search patterns and starting paths are scripted and published in the JSON report.
- The optimized budgets are the CLI's balanced defaults: 32,000 prompt, 4,000 map, 4,000 schemas and 3,000 tokens per result. Stored-artifact references are deterministic handles; this benchmark retains full outputs in memory and does not create an agent session.
- Estimated tokens use the runtime's `ceil(UTF8 bytes / 3)` heuristic. Total context counts `system + JSON.stringify(messages) + JSON.stringify(tools)`, matching the runtime estimate before provider wrappers. Component sizes are measured separately, so JSON escaping and rounding mean columns do not sum exactly. These are estimates, not billed token counts.

## Measured prompt size

| Identical task | Full estimated tokens | Optimized estimated tokens | Reduction | Checked evidence, full → optimized |
| -------------- | --------------------: | -------------------------: | --------: | ---------------------------------: |
| visuals        |               454,433 |                     12,439 |     97.3% |                          6/6 → 6/6 |
| permissions    |               454,220 |                     13,876 |     96.9% |                          7/7 → 7/7 |
| extensions     |               451,517 |                     15,556 |     96.6% |                          7/7 → 7/7 |

The full-schema stress baseline may exceed a model's context window. The percentages describe these particular prepared prompts, not universal savings or equivalent model outcomes. They include the deliberately large synthetic catalog; the component table separates its contribution from repository context and bounded results.

| Task        | Repository map estimated tokens | Schemas, full → lazy | Tool results, full → bounded | Exposed schemas, initial → discovered / catalog |
| ----------- | ------------------------------: | -------------------: | ---------------------------: | ----------------------------------------------: |
| visuals     |                           4,000 |      257,540 → 1,794 |               15,865 → 5,026 |                                   9 → 11 / 1013 |
| permissions |                           3,998 |      257,540 → 2,514 |               15,676 → 5,740 |                                   9 → 14 / 1013 |
| extensions  |                           3,998 |      257,540 → 2,507 |               13,041 → 7,064 |                                   9 → 14 / 1013 |

The full numbered source snapshot is 514,739 UTF-8 bytes (171,580 estimated tokens); the raw-source count above excludes file headings and line labels. Scoped reads still carry the implementation lines needed to assess the task, while the map contributes module signatures and relations.

## Local latency

Both assembly measurements start with the same source, graph, schema and retrieval data in memory. Each sample includes context construction, schema selection where applicable, JSON serialization and the UTF-8 estimate. They exclude disk access, tool execution, provider serialization and network/model time. Discovery and retrieval are separately observed once per task; they are not summed into a claimed end-to-end speedup.

| Task        | Discovery ms | Retrieval ms | Full assembly median / p95 ms | Optimized assembly median / p95 ms |
| ----------- | -----------: | -----------: | ----------------------------: | ---------------------------------: |
| visuals     |         1.00 |        18.60 |                   1.49 / 2.07 |                        1.22 / 1.43 |
| permissions |         0.57 |        14.42 |                   1.49 / 2.70 |                        1.21 / 1.29 |
| extensions  |         0.48 |        23.29 |                   1.31 / 2.10 |                        1.27 / 1.31 |

Snapshot preparation: first observed scan 74.94 ms, warm verification scan 42.97 ms, source reads 0.60 ms. The first scan may already have a persisted cache; it is **not a cold-scan benchmark**. The warm scan parsed 0 files and reused 156. Registering/validating the 1,000-schema fixture took visuals: 160.89 ms; permissions: 115.78 ms; extensions: 105.36 ms, excluded from prompt assembly timings.

## Evidence coverage

Coverage means a known repository path and its exact numbered implementation line survive in a model-facing message. It does not evaluate an answer or prove every fact required for a complete implementation is present. The checks are explicit source anchors, not signatures alone; the full baseline naturally contains them because it includes all source. Search matches, not these checks, drive the scoped reads.

| Task        | Checked fact                                    | Source line                                                                            | Optimized prompt |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------- |
| visuals     | Layout is deterministic                         | [packages/architecture/src/render.ts:175](../packages/architecture/src/render.ts#L175) | present          |
| visuals     | Orthogonal graph edges                          | [packages/architecture/src/render.ts:174](../packages/architecture/src/render.ts#L174) | present          |
| visuals     | SVG scene renderer                              | [packages/architecture/src/render.ts:277](../packages/architecture/src/render.ts#L277) | present          |
| visuals     | PNG rasterizer and bundled font                 | [packages/architecture/src/render.ts:381](../packages/architecture/src/render.ts#L381) | present          |
| visuals     | Viewport coordinate conversion                  | [packages/architecture/src/render.ts:222](../packages/architecture/src/render.ts#L222) | present          |
| visuals     | Rectangle hit testing                           | [packages/architecture/src/render.ts:235](../packages/architecture/src/render.ts#L235) | present          |
| permissions | Default is YOLO                                 | [apps/cli/src/config.ts:35](../apps/cli/src/config.ts#L35)                             | present          |
| permissions | Settings validate all three modes               | [apps/cli/src/config.ts:59](../apps/cli/src/config.ts#L59)                             | present          |
| permissions | Read tools bypass approvals                     | [packages/core/src/tools.ts:157](../packages/core/src/tools.ts#L157)                   | present          |
| permissions | YOLO bypasses approvals after policy validation | [packages/core/src/tools.ts:159](../packages/core/src/tools.ts#L159)                   | present          |
| permissions | Read-only denies mutations                      | [packages/core/src/tools.ts:167](../packages/core/src/tools.ts#L167)                   | present          |
| permissions | Ask validates explicit approval decisions       | [packages/core/src/tools.ts:212](../packages/core/src/tools.ts#L212)                   | present          |
| permissions | Remembered approvals persist before execution   | [packages/core/src/tools.ts:225](../packages/core/src/tools.ts#L225)                   | present          |
| extensions  | Inactive schemas excluded                       | [packages/core/src/tools.ts:79](../packages/core/src/tools.ts#L79)                     | present          |
| extensions  | Schema token ceiling                            | [packages/core/src/tools.ts:87](../packages/core/src/tools.ts#L87)                     | present          |
| extensions  | Discovery activates matches                     | [apps/cli/src/tools/discovery.ts:23](../apps/cli/src/tools/discovery.ts#L23)           | present          |
| extensions  | Skill bodies load lazily                        | [apps/cli/src/tools/discovery.ts:45](../apps/cli/src/tools/discovery.ts#L45)           | present          |
| extensions  | MCP connects on discovery                       | [packages/integrations/src/mcp.ts:154](../packages/integrations/src/mcp.ts#L154)       | present          |
| extensions  | MCP tools initially inactive                    | [packages/integrations/src/mcp.ts:232](../packages/integrations/src/mcp.ts#L232)       | present          |
| extensions  | Failures explicitly are not replayed            | [packages/integrations/src/mcp.ts:243](../packages/integrations/src/mcp.ts#L243)       | present          |

## What remains unmeasured

A live comparison would need repeated identical tasks, fixed provider/model versions, actual usage records, completion/verification scoring, retry counts and total request latency. This offline run provides none of those results. In particular it cannot establish that a smaller initial prompt saves total task tokens if a model needs additional searches or retries. No real marketplace discovery, MCP connection startup or terminal graphics latency is included.
