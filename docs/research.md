# Design research

Research completed before implementation on 2026-10-10. This is an independent implementation.

| Source                                                                        | Adopted boundary                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) | Typed tool/model events, application state separate from model context |
| [OpenCode](https://opencode.ai/docs/server/)                                  | Headless runtime with independent clients                              |
| [Claude Code](https://code.claude.com/docs/en/how-claude-code-works)          | Gather, act, verify loop and deferred discovery                        |
| [Aider](https://aider.chat/docs/repomap.html)                                 | Budgeted graph-ranked repository maps                                  |
| [OpenTUI](https://opentui.com/docs/components/image/)                         | Managed Kitty/Sixel graphics, readable tree fallback                   |
| [Agent Plugins](https://agent-plugins.org/specification)                      | Portable skills/MCP with vendor adapters                               |
| [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)        | Stable prefixes and actual cached-token accounting                     |

The user-supplied Claude mirror calls itself leaked source and has no identified reuse grant. No code is copied from it. Public behavior documentation informs the independently authored loop.

Current registry checks: OpenTUI 0.5.17, MCP client 2.3.1, ELK 0.12.0, resvg 2.6.2. OpenTUI 0.5.17 supports Bun >=1.3.0; the local Bun 1.3.13 meets this requirement. Graphics capabilities vary by terminal; real image transport needs separate smoke verification from cell snapshots.
