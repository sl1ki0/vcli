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

## Chat, reasoning and OpenRouter

Follow-up research on 2026-10-12 used the installed OpenTUI contracts and current
official documentation. Native Markdown rendering and scrollboxes retain formatted
streaming responses. Submitted user prompts use immediate plain-text rendering.
The [standalone executable documentation](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/reference/standalone-executables.mdx)
is supplemented by a compiled client smoke outside the checkout, including formatted
code blocks and terminal cleanup.

| Source                                                                                                                                                               | Implementation decision                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)                                                                                          | Native effort fields; opt-in summaries; encrypted continuation stays opaque                                  |
| [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)         | Native effort/adaptive thinking where supported; preserve signatures                                         |
| [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking), [official SDK guidance](https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md) | GenerateContent thinking levels for Gemini 3; earlier budget-only models reject effort tuning                |
| [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [routing](https://openrouter.ai/docs/guides/routing/provider-selection)   | Default gateway endpoint; exact reasoning-detail continuation; require parameter support for explicit effort |

Reasoning defaults omit tuning fields. Explicit effort does not change the chosen
model or silently convert effort to a token budget. Known unsupported combinations
fail locally; unknown model capabilities remain subject to the provider's response.
