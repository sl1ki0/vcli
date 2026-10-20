# vcli contributor instructions

## Product and boundaries

- Architecture-first CLI: separate observed/intended/change graphs; full-screen
  chat, Markdown, sent messages, history/settings. YOLO default, also ask/read-only.
  Target macOS/Linux/WSL. Prioritize token savings and modular services/controllers.
- Parallel ownership authorized. Small verified commits/pushes to origin/main;
  existing identity, no AI trailers. Preserve user edits. Never inspect, overwrite,
  format, stage or commit personal `.vcli/config.json`, credentials, `.env`,
  sessions, artifacts or binaries.
- Use official/licensed sources; never copy leaked tanbiralam/claude-code code or
  claim vendor parity. Pin Bun 1.3.13, strict TS 5.9.3 and deps; preserve lock/licenses.
- Enforce .vcli/architecture.json: core = portable contracts/runtime/context/
  budgets/permissions (no terminal/SDK/Bun/filesystem/subprocess); architecture =
  analysis/design/drift/layout/SVG/PNG, no inference; providers = SDK adapters;
  integrations = skills/plugins/catalogs/lazy MCP; tui = presentation/controllers,
  no agent tools; apps/cli = composition/tools/config/SQLite, with disk/process
  implementations in src/workflows/.

## Runtime invariants

- One AgentRuntime, run IDs = session IDs, no homework loop. Validate/authorize
  before wrappers; persist starts before effects, results before next mutation.
  Parallel reads; serialize writes/shell/hooks/plan metadata.
- Reject schemas before approval/start, no coercion. Stop after three repeated
  schema errors/tool, persist across empty resumes; new human input resets guard,
  corrected args clear that tool's count. Discover schemas with tools_search.
- Never replay uncertain effects. Inspect then explicit retry/fail/abort plus file
  attribution; retry only repeatable tools. Duplicate IDs cannot mutate twice;
  changed tool/args are protocol errors. Bookkeeping cannot disguise successful
  edits. Cancellation drains concurrent children before storage closes.
- Atomically reserve whole batches against model/tool/effect/result-byte counters
  before calls. Preserve through planning/approval/resume/retry. Bound unknown
  output; retain conservative charges for missing outcomes. Reserve task tokens
  before inference/delegation; reconcile actual usage, settle idempotently.
  Explorers share parent tokens AND resource counters.
- Ask: arrows/Enter, durable session/project/contract grants. Revalidate on resume.
  /permission (Ctrl+P) saves then updates gates; YOLO releases pending approvals,
  read-only denies, running actions finish. Plan/read-only win. Strict deletion asks.
- Optional external policy: deny-first exact simple Bash, canonical paths/cwd inside
  project, reject traversal/links; inherit in explorers/hooks/lazy startup. Reads
  with hooks/startup are charged and approved as compound effects.
- Separate model text/artifacts/UI. Balanced: prompt32k/map4k/schemas4k/result3k/
  output8k. Count instructions/output reserve within window (unknown 32,768).
- Preserve task ledger and human chat; prune complete tool groups. Session.chat =
  presentation; Session.messages = provider context. Persist cards/results together;
  UI previews/full recovery diffs stay out of model context. Restore unfinished
  tools interrupted, never replay. Preserve opaque continuations; clear on provider
  switch. SQLite snapshots/event watermarks prevent duplicate stream replay.
- Provider/endpoint credentials separate from project settings; mask keys.
  OpenRouter never borrows OpenAI keys. Users explicitly select models.

## Workflows and terminal

- Plan Mode requires structured plan_publish, denies edits/shell/hooks/MCP, persists
  on resume. /plan approve or /build approves a draft under configured permissions.
  Chat first; /plan visual opens dependencies. Tasks validate dependency graphs and
  successful recorded verification-tool evidence. Archive completed plans on new
  human input; empty resumes skip completed work.
- architecture_preview stays draft across scans; architecture_propose persists
  intended design before structural edits. Draft restart restoration remains open.
- Reload root AGENTS.md/CLAUDE.md/.vcli/MEMORY.md each run within combined 2k tokens.
  Keep this file concise. Memory writes require memory_read's revision.
- Explorers: isolated read-only, max two, depth one, no shell/MCP/hooks/nesting;
  default 12k, range 4k–24k, max 6 turns; transcripts are artifacts.
- Checkpoints preserve native patch bytes/modes; restore newest first, refuse
  external/uncertain edits. Exclude shell/MCP/memory/design and chat rewind.
- Whole-run journals cover allowed creates/edits/deletes, including shell/hooks.
  Guard trees before mutations; validate ALL touched hashes/paths before rollback.
  Resolve uncertainty first. Explicit private/generated/policy-denied exclusions
  and snapshot limits: docs/runtime.md.
- .vcli/hooks.json: beforeTool/afterTool, gated commands, bounded output, timeout/
  process-group cancellation. Post-hook failures preserve actual tool outcomes.
- Startup order: static OpenTUI core, dynamic Solid preload, then dynamic Solid/
  workspace imports; compiled clients outside checkout require it.
- Graph -> LayoutScene -> SVG -> PNG -> OpenTUI image; shared render/hit geometry,
  independent repaint, tree fallback, separate graph views.
- Physical Ctrl+C and /stop cancel; /exit drains. F2 /chat, /split, F3 architecture.
  Local navigation/settings/history/plans make no model calls. One /help/suggestion
  catalog: arrows select, Tab completes, Enter completes partial/submits exact,
  Esc preserves draft; hide compatibility aliases.

## Verification and handoff

- Use rg and meaningful tests. bun install --frozen-lockfile; bun run format:check;
  bun run lint; bun run check; bun test; bun run dev architecture check; bun run
  build; bun run smoke. Source+compiled PTY outside checkout: cleanup, worker/font,
  graphics, FD256. Local 2026-10-20: 356 tests / 2,062 assertions; reverify changes.
- bun run benchmark --write docs/benchmarks.md: offline estimates, no paid-model
  savings/completion claims. Fixtures use no paid APIs. tests/run-acceptance.test.ts:
  ordinary harness, unchanged Python tests, Bash, three verified dependent tasks,
  restart/diff/rollback. Example: fixtures/order/; guide: docs/runtime.md.
- Gaps: background/write/custom agents, nested memory, vendor hooks, chat rewind,
  hosted/IDE/login/browser parity, Windows, deeper languages, live benchmarks.
- Details: README.md; docs/{runtime,architecture,local-workflows,validation,
  artifact-quickstart,research,benchmarks,extension-compatibility}.md. Update handoff
  when invariants change.
