# Offline context benchmark

Measured 2026-10-21T12:38:26.409Z. This benchmark measures prompt size, local preparation time and source evidence presence. **No model requests or paid APIs were called.** It does not measure task completion, answer accuracy, retries, total session tokens, provider tokenization, cached-token billing or remote model latency.

## Reproduce

`bun run benchmark --write docs/benchmarks.md`

Use `--json` for the full machine-readable report and `--iterations 50` to change assembly timing samples. The default is 25 samples after three warmups. Source edits change results; timing varies with the machine and cache. The script rejects a changing source snapshot and fails if a checked evidence line disappears from the optimized prompt. It imports no provider adapter and has no live-provider option.

## Fixture and method

- Production source corpus: 134 module files under `apps/*/src` and `packages/*/src`, with tests, build scripts, dependencies, binaries and documentation excluded. Raw source is 644,277 UTF-8 bytes (214,759 estimated tokens).
- Source SHA-256: `fe6499f491bd2df8fce502ff3833bab5a6d616a7ea50642d01df92fee55c2c95`. Git HEAD: `d25766753810279f27837997756fab8e8017603d`; source hash is authoritative because the working tree can contain changes. Graph revision: `33e4002967769f50e343`; intended-design SHA-256: `72607ffa0e3b3ba653f37d2edb462859337a54622bc83ddc5f339e7dde30a0c0`. These capture the repository inputs separately from the scripted tool fixture.
- Environment: Bun 1.3.13, darwin 24.6.0, arm64, Apple M4.
- Schema fixture: exactly 1,000 deterministic **synthetic** extension schemas across five categories, plus actual built-in schemas. The fixtures represent a large catalog and are never executed. They are not a measurement of an installed marketplace or real MCP server.
- Both paths receive each identical task question, the same system instruction, ledger, tool-call recipe and retrieved source. Full context injects every production source file with numbered lines, every schema and complete tool results. Optimized context calls actual `repositoryMap`, `boundText`, `BudgetContextPlanner`, `ToolRegistry` and built-in tools, activates up to five search matches, and includes scoped reads around visible search matches. There is no model-driven retrieval here: search patterns and starting paths are scripted and published in the JSON report.
- The optimized budgets are the CLI's balanced defaults: 32,000 prompt, 4,000 map, 4,000 schemas and 3,000 tokens per result. Stored-artifact references are deterministic handles; this benchmark retains full outputs in memory and does not create an agent session.
- Estimated tokens use the runtime's `ceil(UTF8 bytes / 3)` heuristic. Total context counts `system + JSON.stringify(messages) + JSON.stringify(tools)`, matching the runtime estimate before provider wrappers. Component sizes are measured separately, so JSON escaping and rounding mean columns do not sum exactly. These are estimates, not billed token counts.

## Measured prompt size

| Identical task | Full estimated tokens | Optimized estimated tokens | Reduction | Checked evidence, full → optimized |
| -------------- | --------------------: | -------------------------: | --------: | ---------------------------------: |
| visuals        |               529,645 |                     12,569 |     97.6% |                          6/6 → 6/6 |
| permissions    |               530,965 |                     14,494 |     97.3% |                          7/7 → 7/7 |
| extensions     |               531,155 |                     16,217 |     96.9% |                          7/7 → 7/7 |

The full-schema stress baseline may exceed a model's context window. The percentages describe these particular prepared prompts, not universal savings or equivalent model outcomes. They include the deliberately large synthetic catalog; the component table separates its contribution from repository context and bounded results.

| Task        | Repository map estimated tokens | Schemas, full → lazy | Tool results, full → bounded | Exposed schemas, initial → discovered / catalog |
| ----------- | ------------------------------: | -------------------: | ---------------------------: | ----------------------------------------------: |
| visuals     |                           3,994 |      258,476 → 1,934 |               16,698 → 5,026 |                                  10 → 12 / 1016 |
| permissions |                           3,999 |      258,476 → 2,654 |               17,903 → 6,156 |                                  10 → 15 / 1016 |
| extensions  |                           3,998 |      258,476 → 2,647 |               17,873 → 7,517 |                                  10 → 15 / 1016 |

The full numbered source snapshot is 727,261 UTF-8 bytes (242,421 estimated tokens); the raw-source count above excludes file headings and line labels. Scoped reads still carry the implementation lines needed to assess the task, while the map contributes module signatures and relations.

## Local latency

Both assembly measurements start with the same source, graph, schema and retrieval data in memory. Each sample includes context construction, schema selection where applicable, JSON serialization and the UTF-8 estimate. They exclude disk access, tool execution, provider serialization and network/model time. Discovery and retrieval are separately observed once per task; they are not summed into a claimed end-to-end speedup.

| Task        | Discovery ms | Retrieval ms | Full assembly median / p95 ms | Optimized assembly median / p95 ms |
| ----------- | -----------: | -----------: | ----------------------------: | ---------------------------------: |
| visuals     |         1.42 |        46.20 |                   2.91 / 5.81 |                        2.37 / 5.45 |
| permissions |         0.80 |        71.00 |                   3.32 / 7.84 |                        2.36 / 3.28 |
| extensions  |         0.73 |        60.03 |                   2.57 / 4.35 |                        2.37 / 2.53 |

Snapshot preparation: first observed scan 204.16 ms, warm verification scan 114.87 ms, source reads 1.16 ms. The first scan may already have a persisted cache; it is **not a cold-scan benchmark**. The warm scan parsed 0 files and reused 207. Registering/validating the 1,000-schema fixture took visuals: 2380.72 ms; permissions: 2083.04 ms; extensions: 1495.15 ms, excluded from prompt assembly timings.

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
| permissions | Default is YOLO                                 | [apps/cli/src/config.ts:38](../apps/cli/src/config.ts#L38)                             | present          |
| permissions | Settings validate all three modes               | [apps/cli/src/config.ts:65](../apps/cli/src/config.ts#L65)                             | present          |
| permissions | Read tools bypass approvals                     | [packages/core/src/tools.ts:181](../packages/core/src/tools.ts#L181)                   | present          |
| permissions | YOLO bypasses approvals after policy validation | [packages/core/src/tools.ts:183](../packages/core/src/tools.ts#L183)                   | present          |
| permissions | Read-only denies mutations                      | [packages/core/src/tools.ts:197](../packages/core/src/tools.ts#L197)                   | present          |
| permissions | Ask validates explicit approval decisions       | [packages/core/src/tools.ts:286](../packages/core/src/tools.ts#L286)                   | present          |
| permissions | Remembered approvals persist before execution   | [packages/core/src/tools.ts:299](../packages/core/src/tools.ts#L299)                   | present          |
| extensions  | Inactive schemas excluded                       | [packages/core/src/tools.ts:82](../packages/core/src/tools.ts#L82)                     | present          |
| extensions  | Schema token ceiling                            | [packages/core/src/tools.ts:90](../packages/core/src/tools.ts#L90)                     | present          |
| extensions  | Discovery activates matches                     | [apps/cli/src/tools/discovery.ts:24](../apps/cli/src/tools/discovery.ts#L24)           | present          |
| extensions  | Skill bodies load lazily                        | [apps/cli/src/tools/discovery.ts:46](../apps/cli/src/tools/discovery.ts#L46)           | present          |
| extensions  | MCP connects on discovery                       | [packages/integrations/src/mcp.ts:247](../packages/integrations/src/mcp.ts#L247)       | present          |
| extensions  | MCP tools initially inactive                    | [packages/integrations/src/mcp.ts:330](../packages/integrations/src/mcp.ts#L330)       | present          |
| extensions  | Failures explicitly are not replayed            | [packages/integrations/src/mcp.ts:341](../packages/integrations/src/mcp.ts#L341)       | present          |

## What remains unmeasured

A live comparison would need repeated identical tasks, fixed provider/model versions, actual usage records, completion/verification scoring, retry counts and total request latency. This offline run provides none of those results. In particular it cannot establish that a smaller initial prompt saves total task tokens if a model needs additional searches or retries. No real marketplace discovery, MCP connection startup or terminal graphics latency is included.
