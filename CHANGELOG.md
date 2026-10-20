# Changelog

## 2026-10-20

- Consolidated development in `main`. Retained live permission switching, physical
  Ctrl+C handling and graceful `/exit`; removed obsolete `master` and
  `multiagents-homework` branches without importing the separate homework runtime.
- Added pinned ESLint with TypeScript rules and a zero-warning CI check alongside
  Prettier. Applied type-only imports and removed unused code and ambiguous
  expression statements. Personal configuration and generated state are excluded.
