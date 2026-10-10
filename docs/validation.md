# Validation record

This release is validated locally on macOS arm64 with Bun 1.3.13. Run
`bun run check`, `bun test`, `bun run build`, `bun run smoke` and
`bun run benchmark` to reproduce the checks.

The final local suite passes 96 tests with 428 assertions. Formatting, strict
type checking and the declared package dependency check also pass.

The [macOS and Linux CI run](https://github.com/sl1ki0/vcli/actions/runs/38065175676)
passed the same checks, including native builds, standalone pseudoterminal smoke,
the benchmark and release artifact upload.

## Automated coverage

- A real SDK connected to a local streaming HTTP fixture completes architecture
  query → design proposal → source patch → shell verification → graph update →
  SQLite resume. Proposal events precede following edits in the same tool batch.
- TS/JS alias resolution, re-exports, workspaces, cycles, same-length changes,
  deleted and externally renamed files, changed compiler settings, malformed syntax
  and corrupt indexes.
- Deterministic layout, grouping limits, viewport hit testing, escaped SVG labels,
  real PNG bytes and a bundled font.
- Terminal keyboard controls, narrow resizing, capabilities changing during a
  session, proposal presentation before the next edit, and mouse selection after
  resizing. Actual Kitty and Sixel image bytes reach the managed transport.
- All four provider SDK wire contracts, cancellation, malformed/incomplete streams,
  continuation signatures, usage accounting and bounded retry behavior.
- All permission modes, budget exhaustion, durable uncertain mutation recovery,
  large output retrieval, Unicode budgets and overlapping-read invalidation.
- Portable/Claude/Codex/Gemini imports, malformed manifests, path containment,
  immutable snapshots, catalog provenance, actual MCP stdio/HTTP negotiation,
  resources, cancellation, uncertain calls and install rollback.
- A compiled binary copied outside the checkout analyzes source, runs its embedded
  layout worker, exports PNG/SVG/JSON, opens SQLite and persists configuration.
  Deliberately invalid local Bun preload and dotenv files are ignored.
- The standalone binary starts in a pseudoterminal with tree and Kitty graphics,
  uploads a real image, and restores the alternate screen and cursor on exit.

No paid model APIs were called. SDK fixture completion proves the orchestration
contract; it does not establish live model success or production API availability.
The offline benchmark estimates prepared context size and local preparation
latency. Live provider token counts, completion rates, retries and inference latency
remain unmeasured.

## Real-terminal matrix

| Environment                      | Current verification                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| Kitty                            | Transport and packaged pseudoterminal verified; real application pending |
| Ghostty                          | Native inspection blocked by the computer-use tool; real smoke pending   |
| iTerm2                           | Not available in this environment; real Sixel smoke pending              |
| WezTerm with configured graphics | Not available; real smoke pending                                        |
| SSH                              | Detection/fallback logic covered; remote-terminal smoke pending          |
| tmux                             | Auto falls back; explicit graphics passthrough smoke pending             |
| Linux / WSL                      | Linux build and standalone smoke passed in CI; manual WSL smoke pending  |

Manual smoke procedure: launch `vcli --root fixtures/sample-project`, confirm graph
labels and routed edges, click and keyboard-select modules, resize, pan, zoom,
switch views, drill/reset, stop a task and quit. Check the shell cursor, mouse mode
and alternate screen return to their previous state. Repeat with `--renderer off`
and explicit protocol overrides where the terminal supports them. Record terminal
version, transport and result before marking a matrix row verified.

## Remaining limits

Model context limits must be configured from the chosen model's documented limit;
unknown models use a conservative 32,768-token window. Task ledger updates depend
on the agent using `task_record`, with tool effects/verification recorded by the
runtime. Compaction prunes complete groups and does not call a summary model.
Plugin state mutations serialize within one manager instance; cross-process
locking and a process-crash journal are not implemented.
