# Validation record

This release is validated locally on macOS arm64 with Bun 1.3.13. Run
`bun run check`, `bun test`, `bun run build`, `bun run smoke` and
`bun run benchmark` to reproduce the checks.

The local suite passes 248 tests with 1,359 assertions, including chat, first-run setup
and the local workflow expansion.
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
The [local workflow CI run](https://github.com/sl1ki0/vcli/actions/runs/38405240570)
passed on macOS and Linux with all 204 tests, native builds, the existing terminal
smoke checks, and the new packaged plan/resume/build/task/checkpoint workflow.
Both `vcli-macOS-ARM64` and `vcli-Linux-X64` artifacts were uploaded successfully.

## Automated coverage

- Planning denies source edits, shell and hook execution. The public CLI preserves
  plan mode on resume, switches only with explicit build selection, persists plans
  and tasks, and restores captured files. This workflow also runs against the
  packaged executable outside the checkout using a local SDK streaming fixture.
- Memory reloads on a resumed run, stays within its automatic token allocation,
  and rejects stale writes. Hooks validate their schema, enforce permission modes,
  serialize tool batches, cancel process groups, and preserve completed mutation
  outcomes when after hooks fail.
- Native file checkpoints preserve bytes and modes, restore new/existing files,
  reject external edits and uncertain outcomes, and retain changes when post-hook
  or checkpoint bookkeeping fails. They do not snapshot arbitrary shell effects.
- Explorer agents use an isolated read-tool allowlist. Concurrent reservations
  share the parent budget; missing usage remains charged, settlement is idempotent,
  and cancellation drains children before closing storage. Tasks persist across
  sessions and reject dependency cycles or blocked state transitions.
- Workspace workflow commands make no model calls. Draft architecture previews
  survive post-task refresh and explicit scans without writing the design document.
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
- Tool permission requests use a dedicated scrollable card with labeled arguments,
  file text before/after, command text, and persistent allow/deny controls. The preview
  retains arguments beyond the former 700-character cutoff. Narrow-terminal scrolling,
  Y/N, Escape/Enter denial and cancellation are covered by renderer tests. Source and
  packaged PTY fixtures verify that a declined edit leaves the file unchanged, an
  accepted edit applies, and both outcomes reach the local provider.
- Architecture tool schemas explicitly declare the version as an integer. A local
  OpenRouter SDK fixture preserves string/number argument types, returns a precise
  validation error for a string, rediscovers the schema, and persists the corrected
  numeric version. Invalid arguments trigger no approval, execution start, hooks
  or checkpoint capture. Argument validation does not coerce model output.
- Tool request/start/end events render durable chat cards with bounded labeled
  inputs, explicit states, visible errors and full saved-result browsing. Source
  and packaged PTY fixtures restore successful/failed/blocked cards after restart,
  open artifacts through the real local loader and make no extra model requests.
  SQLite tests cover hard process termination, old-snapshot migration, event
  watermarks, artifact handles, completed-result snapshots before end publication,
  and uncertain interrupted effects. Terminal controls and credential fields are
  masked in previews; Unicode survives output paging.
- A durable limiter stops inference after three repeated schema problems per tool,
  rejects later mutations in the same batch and drains concurrent reads. Corrected
  arguments clear prior failures; permission/execution failures do not count.
  Empty resume preserves the stop, while explicit human input resets it. Tool
  presentation records remain outside provider context and its token budget.
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

## Ghostty session review, 2026-10-13

The user supplied three screenshots of a completed OpenRouter/DeepSeek folder-size
task. Native Ghostty inspection remains blocked. Targeted read-only checks of the
saved project session confirmed that all four `architecture_propose` calls passed
`design.version` as the JSON string `"1"`. The tool correctly rejected them; the
agent's claim that the tool rejected numeric `1` was unsupported. The OpenRouter
adapter preserves JSON types rather than converting numbers to strings.

The generated Python script and its 12 tests were inspected; all 12 tests passed
again without modifying the project. A separate temporary fixture confirmed that
directory symlinks are skipped. This verifies that output, not a general live-model
completion rate. The screenshot reports 51,306 aggregate tokens, including 20,480
cached tokens, for this one task.

Follow-up priorities:

- **P1, implemented mitigation:** repeated invalid calls and an unjustified tool-bug claim.
  Explicit integer schema, expected/received type diagnostics and model guidance
  now address the observed confusion. A failed proposal is not a persisted design;
  instructions prohibit bypassing that workflow. The runtime now stops after three
  repeated argument errors for the same tool/schema problem. This bounds the loop;
  it does not guarantee that a live model will recover correctly.
- **P1, implemented:** persistent, readable tool activity in chat. Cards retain
  tool name, state, target, error and artifact access after session restoration,
  without adding presentation records to model context.
- **P2, open in the generated Python example:** its usage docstring advertises
  `--human`, while its parser supports `--bytes`; `--human` exits with status 2.
  Traversal silently skips inaccessible entries and can report incomplete totals
  without a warning. Sorting runs three passes where two, or a single composite
  key, suffice. The tests do not cover permission failures or symlink behavior.
- **P2, open:** the agent left a `demo/` fixture in the user's project and called
  generated example data "real data." Prefer temporary fixtures, clean them up,
  and describe the evidence accurately. The user withdrew the reported missing
  chat-message issue after locating their messages; it is not a confirmed defect.

The Python example and its demo files were left unchanged by this review.

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
