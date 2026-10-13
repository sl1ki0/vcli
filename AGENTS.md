# vcli contributor instructions

## Product and collaboration

- Architecture-first TypeScript CLI with observed/intended/change views and usable
  full-screen chat: visible sent messages, Markdown, history and settings.
- Keep code clean and modular, with named services/controllers per responsibility.
- Target macOS/Linux/WSL. YOLO default; also ask/read-only. Prioritize token savings.
- Parallel development authorized; separate ownership. Small verified commits and
  pushes to origin/codex/architecture-first-cli; existing identity, no AI trailers.
- Preserve user changes. `.vcli/config.json` is untracked personal configuration:
  never inspect it for secrets, overwrite, format, stage or commit it. Never commit
  credentials, `.env`, sessions, artifacts or generated binaries.
- Implement public workflows independently from official docs/licensed sources.
  Do not copy the leaked tanbiralam/claude-code mirror or claim full feature parity.

## Stack and boundaries

- Bun 1.3.13, strict TypeScript 5.9.3, OpenTUI/Solid, SQLite, Compiler API, ELK,
  resvg. Pin dependencies; preserve bun.lock and license notices.
- `packages/core`: portable contracts, runtime, context, budgets and permissions.
  No terminal, provider SDK, Bun-specific, filesystem or subprocess imports.
- `packages/architecture`: analysis, design/drift, layout, SVG/PNG; no inference.
- `packages/providers`: OpenAI/Anthropic/Gemini/OpenRouter/compatible SDK adapters.
- `packages/integrations`: portable skills/plugins/catalogs and lazy MCP clients.
- `packages/tui`: presentation/controllers, navigation and chat; no agent tools.
- `apps/cli`: composition, commands, tools, configuration and SQLite drivers.
  `src/workflows/` owns disk/process implementations of local harness features.
- Contracts in core; enforce .vcli/architecture.json dependency boundaries.

## Runtime invariants

- Authorize/validate before execution wrappers. Persist starts before effects,
  results before next mutation. Parallel reads; serialize writes/shell/hooks.
- Reject invalid tool arguments before approval/start events; never coerce types.
- Ask-mode menus use arrows/Enter; remembered approvals persist before effects,
  scoped to conversation/project/tool contract. Plan/read-only always take precedence.
- Stop after three repeated schema errors per tool; persist the guard across empty
  resumes, reset on new human input. Corrected arguments clear that tool's count.
- Never blindly replay uncertain mutations. Resume must inspect current state.
  Post-hook/checkpoint bookkeeping failures must not disguise successful edits.
  Cancellation drains concurrent children before closing storage.
- Separate bounded model text, retrievable full artifacts and UI details.
  Discover deferred schemas through tools_search.
- Balanced: prompt32k/map4k/schemas4k/result3k/output8k. Reserve output within the
  model window (unknown:32,768). Count instructions. Graph operations are local.
- Reserve task tokens durably before inference/delegation; count actual usage and
  retain conservative charges when usage/outcomes are missing. Settlement is
  idempotent. Explorers share the parent budget; they do not get free extra tokens.
- Preserve the task ledger; prune complete tool groups, never human chat history.
- Session.chat is presentation history; Session.messages is provider context.
  Persist tool cards/results together; bounded previews and local artifact views
  never enter model context. Restore unfinished tools as interrupted, never replay.
  Preserve opaque signatures/continuations; clear them on provider switches.
  SQLite snapshots/event watermarks prevent duplicate stream replay.
- Scope credentials to provider/endpoint, separate from project settings. Mask and
  redact keys. OpenRouter never borrows OpenAI keys. Users select models explicitly.

## Workflows and terminal

- Durable plan policy denies edits/shell/hooks/MCP startup; resume retains it.
  /build or --build enables implementation under configured permissions.
- architecture_preview is a draft retained across scans; architecture_propose
  persists intended design before structural edits.
- Reload root AGENTS.md/CLAUDE.md/.vcli/MEMORY.md each run within combined 2k
  tokens. Keep this file concise. Memory writes require memory_read's revision.
- Tasks persist with dependency/cycle validation. Explorers are isolated read-only
  runtimes: max two, depth one, no shell/MCP/hooks/nested delegation; default 12k
  allocation, range 4k–24k, max six turns. Full transcripts remain artifacts.
- Checkpoints preserve native patches' bytes/modes. Restore newest first, refuse
  external/uncertain edits. Shell/MCP/memory/design effects are excluded.
- .vcli/hooks.json: beforeTool/afterTool, gated commands, bounded output,
  timeout/process-group cancellation.
- Preserve TUI boot order: static OpenTUI core import, then dynamic Solid preload,
  then dynamic Solid/workspace imports. Compiled startup outside checkout needs it.
- Graph -> LayoutScene -> SVG -> PNG -> OpenTUI image. Shared render/hit geometry,
  independent repaint, tree fallback. Keep observed/intended/change graphs separate.
- F2 /chat, /split, F3 architecture; expose /history /new /connect /tokens
  /reasoning and workflow commands. Navigation/settings/history make no model calls.
- Prompt slash suggestions share /help's catalog; arrows select, Tab completes,
  Enter completes partial commands or submits exact ones; Esc preserves the draft.

## Verification and handoff

- Use rg; test meaningful behavior.
- `bun install --frozen-lockfile`; `bun run format:check`; `bun run check`;
  `bun test`; `bun run dev architecture check`; `bun run build`; `bun run smoke`.
- TUI/build: source+compiled PTY outside checkout; cleanup, worker/font, FD256.
- `bun run benchmark --write docs/benchmarks.md`: offline estimates, not measured
  paid-model savings/completion rates. Fixtures use no paid APIs.
- Baseline on 2026-10-13: 204 tests / 1,062 assertions; macOS and Linux CI passed:
  https://github.com/sl1ki0/vcli/actions/runs/38405240570
  Artifacts: vcli-macOS-ARM64, vcli-Linux-X64. Reverify changes.
- Local command-completion validation: 263 tests / 1,505 assertions on macOS.
- Open gaps: background/write/custom agents, nested memory/imports, more/vendor
  hooks, conversation rewind, draft preview restart restoration. Hosted/IDE/login,
  browser parity, native Windows and deeper languages deferred. Manual terminal
  matrix/live provider benchmarks incomplete.
- Details: README.md and docs/{architecture,local-workflows,artifact-quickstart,
  validation,research,benchmarks}.md. Update this handoff when invariants change.
