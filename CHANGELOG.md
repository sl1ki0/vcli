# Changelog

## 2026-10-20

- Consolidated development in `main`. Retained live permission switching, physical
  Ctrl+C handling and graceful `/exit`; removed obsolete `master` and
  `multiagents-homework` branches without importing the separate homework runtime.
- Added pinned ESLint with TypeScript rules and a zero-warning CI check alongside
  Prettier. Applied type-only imports and removed unused code and ambiguous
  expression statements. Personal configuration and generated state are excluded.
- Integrated durable model/tool/effect/result-byte budgets, crash receipts, offline
  approvals and conflict-checked whole-run journals into the primary runtime.
  Explorers share counters and token allocations; hooks and lazy startup count as
  effects. Optional external policies restrict paths and exact Bash commands.
- Added structured chat plans, a dependency view, explicit decisions, task evidence
  and restored progress. Completed plans remain in history without blocking new
  requests. Simplified the command catalog around `/plan`, `/view`, `/history`,
  `/permission` and `/help`, retaining compatibility aliases.
- Added the portable order fixture and deterministic primary-harness verification
  through real Bash, including restart, diff, rollback and unchanged test files.
- Fixed deferred Markdown layout when revealing long plan cards. Kept pending
  approvals, saved denials and approved tool contracts effective when a resumed
  launch falls back to YOLO. CI now reports both platforms independently.
