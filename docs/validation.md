# Validation record

This release is validated locally on macOS arm64 with Bun 1.3.13. Run
`bun run check`, `bun test`, `bun run build`, `bun run smoke` and
`bun run benchmark` to reproduce the checks.

The local suite passes 154 tests with 800 assertions, including chat and first-run setup.
Formatting, strict type checking, declared package dependencies, native packaging,
standalone terminal smoke and the offline benchmark also pass. The setup coverage
below was added after the initial build's missing onboarding was reported.
Chat coverage was added after the missing conversation display was reported.

The [onboarding CI run](https://github.com/sl1ki0/vcli/actions/runs/38142726617)
passed on macOS and Linux, including native builds, standalone pseudoterminal smoke,
first-run project/provider/key/budget setup, the benchmark and release artifact upload.
The [resource-limit and output CI run](https://github.com/sl1ki0/vcli/actions/runs/38176545264)
also passed on macOS and Linux with all 116 tests, native packaging, a 384-module
scan under hard and soft file limits of 256, graphics exports and terminal cleanup.
The [chat and history CI run](https://github.com/sl1ki0/vcli/actions/runs/38294566007)
passed on macOS and Linux with the 154-test suite, native builds, standalone
formatted chat/history smoke, first-run setup, graphics, capped file limits and
the offline benchmark. Both platform artifacts were uploaded successfully.

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
- All five provider adapters, SDK wire contracts, cancellation, malformed/incomplete streams,
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
- A child process with verified soft and hard file limits of 256 runs packaged
  help, a 384-module import-chain scan, SVG/PNG exports, tree and Kitty terminal
  startup and terminal cleanup. The hard limit prevents the runtime from raising
  the soft limit. No user or system resource settings are changed.
- Source and compiled output writers deliver over 1 MB of Unicode JSON and
  ordered event lines to a delayed pipe reader before exit. CLI commands and
  headless runtime events await writes, preserving backpressure and key redaction.
- Source and packaged clients launched in an artifact-only folder show a welcome
  with actionable commands. A real pseudoterminal opens a separate source project,
  connects a provider/model, enters a key by typing and bracketed paste, saves token
  budgets, and completes an official SDK request against a local streaming fixture.
  Raw terminal output and reconstructed visible frames never contain the key.
- Session-only credentials remain in memory; explicit local saves use a separate
  private user credential file. Provider/endpoint scope, environment precedence,
  reload, inherited-budget clearing, invalid updates and write failures are covered.
- Source and compiled clients render a streaming Markdown answer with headings,
  emphasis, lists, inline code and a TypeScript code block outside the checkout.
  Sent prompts appear before a gated response; consecutive turns stay visible,
  new conversations reset model context, history selection makes no model calls,
  and saved messages restore after restarting the client. Terminal cleanup is checked.
- Native renderer tests assert bold and inline-code styles, tables, full chat,
  message selection, reasoning expansion, resizing and long session-list scrolling.
  Sending from a transcript over 100 rows reveals the prompt, while later streaming
  respects manual scrolling. Enter during a response retains the unsent draft with feedback.
- History selection commits before another task can change the active session.
  Failed preflight messages survive subsequent display reconciliation. Streaming
  text and reasoning survive a hard-killed child process; event watermarks prevent
  duplicate replay. Legacy snapshots migrate without losing provider signatures.
- OpenRouter uses its default endpoint and isolated key; native reasoning choices
  persist and reach local SDK fixtures. Default omits tuning fields, known unsupported
  efforts fail before saving, and returned reasoning stays separate from answer text
  and encrypted/signed continuation. Continuation is saved before completion callbacks.

No paid model APIs were called. SDK fixture completion proves the orchestration
contract; it does not establish live model success or production API availability.
The offline benchmark estimates prepared context size and local preparation
latency. Live provider token counts, completion rates, retries and inference latency
remain unmeasured.

The reported macOS startup warning about file descriptors has not been reproduced
by lowering both limits to 256. The exact warning was reproduced locally by
making a temporary launch directory's parent unreadable before starting the
binary. Bun emits it for generic startup errors when the soft limit is low;
this demonstrates an alternative cause. The user subsequently confirmed the missing
download had been deleted and a fresh build started successfully. The
[download guide](artifact-quickstart.md#startup-error-mentioning-file-limits)
includes a working-directory isolation check.

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
