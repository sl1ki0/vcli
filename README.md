# vcli

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

English is the primary documentation. The Russian and Simplified Chinese READMEs
translate this guide; command names, configuration keys and UI labels stay unchanged.
The detailed guides under `docs/` are currently in English.

An architecture-first coding agent. Explore the source graph, declare component
boundaries, and watch a design become code in a terminal workspace.

TypeScript · Bun · OpenTUI/Solid · SQLite · ELK · resvg

![Exported sample source architecture](docs/example-architecture.png)

## What you can do

- Explore **observed** source dependencies, declare an **intended** component design,
  and inspect **changes** since opening the workspace. Check declared boundaries locally.
- Work in streaming Markdown chat, switch between split and full-screen views,
  resume saved conversations, and inspect durable tool cards and full result artifacts.
- Plan without source edits, then explicitly enable implementation. Use persistent
  tasks, project memory, guarded file checkpoints, tool hooks and read-only explorers.
- Connect one of five provider adapters and choose the model, reasoning effort,
  permission mode and token budgets explicitly.
- Discover skills and MCP tools lazily, including supported components imported
  from recognized plugin and marketplace formats.

Source dependency analysis focuses on TypeScript and JavaScript using the Compiler
API. Other recognized source files appear as file nodes; deeper language analysis
is deferred. Architecture scanning, layout, navigation and export run locally
without model calls. Coding conversations and model explorers use the selected API.

## Start

For a downloaded build, run `./vcli --root /path/to/your/project`. The executable
opens a welcome screen if no project or provider is ready. Choose **Open project**
and **Connect provider**. Press **F1** for the command menu, or **Esc** to return to
the prompt and type `/help`, `/open` or `/connect`. Each build includes a
[quick-start guide](docs/artifact-quickstart.md).

Downloaded builds are standalone; Bun is needed for source development.
To run from source, install **Bun 1.3.13** and **ripgrep**, then:

```sh
git clone https://github.com/sl1ki0/vcli.git
cd vcli
git switch codex/architecture-first-cli
bun install --frozen-lockfile
bun run dev --root fixtures/sample-project
```

The canvas uses real Kitty or Sixel images when detected. Unsupported terminals
show a navigable tree. Scanning, navigation and export use no model tokens.

Choose a provider and model through `/connect`, or start setup directly:

```sh
bun run dev setup --root fixtures/sample-project
```

Setup includes masked API-key entry and an explicit choice to keep the key for
this launch or save it in a user-only, unencrypted credential file. Settings are
saved for the chosen project. Keys are kept separately from project configuration
and are never shown in status or configuration output. Environment credentials
also work, with the existing shell setup:

```sh
bun run dev config set provider openai
bun run dev config set model YOUR_MODEL_ID
export OPENAI_API_KEY="YOUR_KEY"
bun run dev
```

| Provider                           | Setting      | Credential                              |
| ---------------------------------- | ------------ | --------------------------------------- |
| OpenAI Responses                   | `openai`     | `OPENAI_API_KEY`                        |
| Anthropic Messages                 | `anthropic`  | `ANTHROPIC_API_KEY`                     |
| Gemini                             | `gemini`     | `GEMINI_API_KEY` or `GOOGLE_API_KEY`    |
| OpenRouter Chat Completions        | `openrouter` | `OPENROUTER_API_KEY`                    |
| OpenAI-compatible Chat Completions | `compatible` | `VCLI_COMPATIBLE_API_KEY` when required |

For a compatible server, also set `baseURL` to its API base URL. Model identifiers
are selected explicitly; vcli does not assume a subscription login or a default
paid model. The conservative default context window is 32,768 tokens. Set
`contextWindow` to your model's documented limit; the output reserve is subtracted
from it before preparing context.

OpenRouter uses `https://openrouter.ai/api/v1` by default. Select the gateway model
ID explicitly, such as the `provider/model` ID from your account, through `/connect`.
Credentials remain scoped to the selected provider and endpoint.

**YOLO is the default:** the agent uses your filesystem and network privileges
without approval prompts. Change `permission` to `ask` or `read-only`, or pass
`--permission` for one run. Ask mode denies execution when no interactive approval
channel is available. Permission controls are not a filesystem sandbox.

In the workspace, approval requests show a highlighted menu: **Allow once**,
**Always allow this tool for this conversation**, or **Deny**. Use **Up/Down** to
choose and **Enter** to confirm; **Esc** denies. Each request starts on **Deny**.
**Page Up/Down** scrolls the details. Remembered tool permissions survive a restart
of that conversation; new conversations ask again. A changed tool contract also
requires fresh approval. Plan and read-only modes continue to deny changes.

## Chat and architecture workspace

The workspace opens with architecture and chat together. Select **Chat**, press
**F2**, or type `/chat` to hide the architecture and use the full workspace for
conversation. `/split` restores both; **F3** or `/architecture` expands the canvas.
Wide architecture views include a module tree and source inspector; narrow terminals
offer switchable canvas, tree and inspector panels.

Your message appears as soon as you send it. Responses stream underneath it, with
visible waiting, thinking, tool activity and cancellation states. Markdown renders
headings, emphasis, inline code, lists, links, tables and code blocks. Click a message
or focus chat with **Tab** to navigate; the mouse wheel and **Page Up/Down** scroll.
**Up/Down** move between messages, and **Home/End** jump to the first/latest message.
Press **Esc** to return to the prompt. **Up** in an empty prompt recalls a sent message.

Open `/history` (also `/sessions`) to select a saved conversation. `/new` starts a
separate task. History is stored locally, including partial responses after an
interruption, independently of the model's context budget. Browsing and switching
history make no model calls.

Tool calls appear in the conversation as cards with the action, target and state:
waiting, running, succeeded, failed, interrupted or blocked. Errors stay visible;
select a card and press **Space/Enter** (or click its title) to inspect labeled
inputs and the result preview. Press **F** to open the full saved result locally;
**Left/Right** page through it. Cards and result handles survive restarts, and
older saved sessions recover their tool history from the local event journal.

Three repeated argument-validation errors for the same tool and schema problem
stop the current task before another model request. Corrected arguments reset
that tool's count. The stop survives a restart; send a new message to continue.
Permission refusals and tool execution failures do not count toward this limit.

| Key                      | Action                                        |
| ------------------------ | --------------------------------------------- |
| Tab                      | Cycle prompt, canvas and chat focus           |
| Arrows / mouse click     | Select a module                               |
| Shift + arrows           | Pan                                           |
| `+` / `-`                | Zoom                                          |
| Enter                    | Drill into a module or group                  |
| Space                    | Collapse a parent                             |
| `v`                      | Observed → intended → changes                 |
| `/`                      | Search modules                                |
| `t`                      | Toggle the side tree; cycle narrow panels     |
| Escape                   | Reset search, drill and viewport              |
| `r`                      | Refresh from source                           |
| Ctrl+C                   | Stop the current task; exit when idle         |
| `q` while canvas focused | Exit                                          |
| F1                       | Open the command menu                         |
| F2                       | Toggle full chat and split view               |
| F3                       | Toggle full architecture and split view       |
| Ctrl+P                   | Change permissions, including during approval |

| Prompt commands                               | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `/help`, `/commands`                          | Open the command menu                    |
| `/open`, `/connect`, `/config`, `/status`     | Project, provider and settings           |
| `/tokens`, `/reasoning`, `/permission`        | Budgets, model effort and permissions    |
| `/chat`, `/split`, `/architecture`            | Workspace layout                         |
| `/history`, `/sessions`, `/new`               | Saved and new conversations              |
| `/observed`, `/intended`, `/changes`, `/scan` | Architecture views and refresh           |
| `/plan`, `/build`, `/plans`                   | Planning, implementation and saved plans |
| `/memory`, `/tasks`, `/hooks`                 | Inspect local workflow state             |
| `/checkpoints`, `/rewind <id>`                | Inspect and restore captured file edits  |
| `/plugins`, `/skills`                         | Inspect available extensions             |

Type `/` in the prompt to see commands with descriptions; keep typing to filter.
Use **↑/↓** to select, **Tab** to complete, and **Esc** to hide suggestions while
keeping your draft. **Enter** completes a partial command; press it again to run.
Fully typed commands run immediately on Enter. `/permission` and `/reasoning`
also suggest their supported arguments. Click a suggestion to fill the prompt.
Tab cycles focus when no suggestions are open. Suggestions use no model calls.
`/permission yolo`, `/permission ask` and `/permission read-only` change the active
agent's permissions immediately after saving; `/permissions` is an alias. During
an approval, press **/** to type a command or **Ctrl+P** to open the permission menu.
YOLO releases the pending approval; read-only denies it. Actions already executing
finish normally. Plan mode still forbids edits, commands, hooks and MCP startup.
**Ctrl+C** stops the active task and keeps the chat open. Extended terminal keyboard
protocols use the physical C key across layouts. You can also type `/stop` or click
**Stop** above the chat. Partial responses remain in history; send a new message to
continue. When no task is running, Ctrl+C exits.
Configuration and navigation use no model calls. `/tokens` edits the
context window, prompt/result/schema/map ceilings, response reserve and task budget.
`/reasoning` chooses `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
or `max`. `default` preserves the model's native behavior; available levels depend
on the provider and model. Known incompatible selections are rejected before saving.
Provider-exposed reasoning appears in a collapsible section of the response;
opaque continuation data stays separate from displayed text.
Select an assistant message and press **Space** or **Enter** to show or hide its
returned reasoning, or click the reasoning section.
The intended design appears as soon as `architecture_propose` completes, before
the next mutation starts. Source changes trigger reconciliation; idle refreshes
also detect external edits. Changes are compared with the graph at workspace open.

```sh
vcli architecture scan --root ./project --json
vcli architecture view --root ./project --renderer kitty
vcli architecture export --root ./project --format png --output architecture.png
vcli architecture export --root ./project --format svg
vcli architecture export --root ./project --format json
vcli architecture check --root ./project
```

Renderer overrides: `auto`, `kitty`, `sixel`, `blocks`, `off`. Auto chooses the tree
inside multiplexers unless graphics are explicitly requested. See the
[terminal validation record](docs/validation.md) for tested behavior and remaining
real-terminal checks.

Intended components and dependency rules live in `.vcli/architecture.json`.
Commit that document. Derived indexes, SQLite sessions and complete tool outputs
live in `.vcli/state/` and `.vcli/artifacts/`; add both paths to your project's
`.gitignore`. The [sample project](fixtures/sample-project/.vcli/architecture.json)
and [vcli's own design](.vcli/architecture.json) show the version 1 format.
Omitted `dependencies` allow any component dependency; an explicit array is an
allowlist. `forbiddenDependencies` takes precedence. Drift checks include source
evidence and exit with status 1 on violations.

## Tasks, sessions and token budgets

```sh
vcli run "Extract persistence into a storage component and verify the tests"
vcli run "Inspect the module boundaries" --permission read-only --json
vcli run "Plan the API boundary change" --plan --json
vcli sessions list
vcli sessions resume SESSION_ID "Continue and verify the result"
vcli sessions resume PLAN_SESSION_ID "Implement the plan" --build
```

`--json` emits newline-delimited runtime events without terminal escape sequences.
Interrupted mutation outcomes remain in the ledger and are inspected on resume;
vcli never automatically replays them. Changing providers discards provider-specific
continuation data and retains portable messages and task state.

Balanced defaults are configurable:

| Setting                |                            Default |
| ---------------------- | ---------------------------------: |
| `context.promptTokens` |                      32,000 target |
| `context.mapTokens`    |                              4,000 |
| `context.schemaTokens` |                              4,000 |
| `context.resultTokens` |                              3,000 |
| `context.outputTokens` |                     8,000 reserved |
| `context.maxTurns`     |                                 40 |
| `context.taskTokens`   | Unset; explicit total task ceiling |

```sh
vcli config set context.taskTokens 100000
vcli config set permission ask --project
vcli config set reasoning high --project
vcli config show
```

Precedence: CLI options → project `.vcli/config.json` → user
`~/.config/vcli/config.json` → defaults. `VCLI_CONFIG_HOME` changes the user directory.
Credentials come from environment variables, the current launch, or the separate
user credential store. Context-size estimates use UTF-8 bytes
divided by three; provider-reported input, output and cached usage are recorded
separately. Unchanged overlapping reads are omitted, full outputs remain retrievable,
and old complete tool groups are pruned while the durable ledger is retained.
There is no paid summarization step in this release. Unknown extension schemas
and skill bodies are loaded only after discovery.

Task budgets reserve the estimated input and response allowance before each model
call. Reported usage reconciles that reservation; missing usage or an interrupted
request retains it across resume, so an absent usage report cannot bypass the limit.

The [reproducible offline benchmark](docs/benchmarks.md) compares identical evidence
tasks with full-source/full-schema prompts. It measures prepared context and local
latency; live model completion rate and provider billing savings are not established.

## Skills, MCP and marketplaces

Project skills are discovered in `.vcli/skills`, `.agents/skills`, `.claude/skills`,
`.gemini/skills` and `.qwen/skills`. Recognized Agent Plugins, Claude catalogs/packages,
Codex catalogs/packages, Gemini and Qwen extensions, and Qoder packages are
normalized to supported skills and MCP servers. Vendor hooks, commands, agents and host UI features are reported as
unsupported. Credentials and connected app accounts require separate integrations.

```sh
vcli plugins formats
vcli plugins inspect ./my-plugin
vcli plugins install ./my-plugin
vcli plugins install ./multi-host-plugin --format qwen
vcli plugins install https://github.com/team/plugins.git --ref COMMIT_SHA --subdir plugins/design
vcli plugins list
vcli plugins marketplace add team https://github.com/team/catalog.git --ref COMMIT_SHA
vcli plugins marketplace list
vcli plugins install design --marketplace team
vcli plugins marketplace refresh team
vcli plugins remove design
```

Installs copy snapshots and record provenance. Hooks never run during installation.
Sources are local directories or Git repositories. Archive/npm installation,
standalone HTTP catalogs, legacy SSE and interactive OAuth are not supported.
MCP stdio programs and HTTP connections start on discovery through the permission
gate. Their schemas are deferred, arguments validated, and cancelled or uncertain
calls are never retried. Supported transports are stdio and Streamable HTTP.
Configuration, import compatibility and storage limitations are documented in
[integrations](packages/integrations/README.md) and the
[compatibility matrix](docs/extension-compatibility.md).

## Local coding workflows

Use `/plan` to explore and preview a design without source edits, then `/build`
to implement it. `/plans`, `/memory`, `/tasks`, `/hooks` and `/checkpoints` inspect
local records without model calls. `/rewind <id>` restores a captured native file
edit only when the file still matches that edit.

The harness loads root project instructions, supports revision-checked persistent
memory, dependency-aware tasks, before/after command hooks, and up to two isolated
read-only model explorers sharing the parent's token budget. Native file listing
and Git diff tools are available through deferred discovery.

See [local workflows](docs/local-workflows.md) for commands, hook configuration,
token accounting, checkpoint coverage and a feature support matrix. These are
independent implementations of documented workflows; complete Claude Code parity
is not claimed.

Plan mode persists on resume and denies source edits, shell, hooks and MCP startup,
even under YOLO. `/build` enables implementation under the configured permissions.
Live draft preview restoration across restarts is still open. Automatic instruction
loading covers root `AGENTS.md`, `CLAUDE.md` and `.vcli/MEMORY.md`, with a combined
2,000-token allocation; nested instructions and imports are not interpreted.
Explorers are read-only, limited to two concurrently, six turns each and a default
12,000-token allocation from the parent's budget. Checkpoints cover native file
edits, excluding shell, MCP, memory and design effects; they do not rewind chat.

## Repository structure

| Path                           | Responsibility                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| `packages/core`                | Portable contracts, agent runtime, context, budgets and permissions |
| `packages/architecture`        | Source analysis, intended design, drift, layout and SVG/PNG export  |
| `packages/providers`           | Provider SDK adapters, normalized streams and continuation state    |
| `packages/integrations`        | Plugin/catalog normalization, skills and lazy MCP clients           |
| `packages/tui`                 | Workspace presentation, chat and navigation controllers             |
| `apps/cli`                     | Commands, configuration, tools, local workflows and SQLite drivers  |
| `scripts`, `tests`, `fixtures` | Build, smoke, benchmarks and offline verification                   |

The core has no terminal, provider SDK, filesystem, subprocess or Bun-specific
imports. The architecture engine does not run inference; the TUI does not own
agent tools. `.vcli/architecture.json` declares the enforced package boundaries.

## Coding-agent homework

The `multiagents-homework` branch includes the exact Python exercise and an opt-in
`homework` workflow covering the assignment through level 10. Install Bun 1.3.13,
Bash and Python 3.9+, then run its deterministic tests without an API key:

```sh
git switch multiagents-homework
bun install --frozen-lockfile
bun run test:homework
```

Its model tools are `Bash(command, cwd)`, `list_files`, `read_file`, `write_file`,
`delete_file`, `submit_plan`, and `complete_task`. Bash returns stdout, stderr and
exit code. The external [example policy](fixtures/homework/policy.json) allows
`python3 -m unittest -v`, denies an example command and the `private` directory,
and rejects unlisted commands, shell syntax, traversal and linked paths. It is
a policy boundary, not process isolation; use a disposable copy without secrets.

```sh
HOMEWORK_DIR=$(cd "$(mktemp -d)" && pwd -P)
cp -R fixtures/homework/workspace "$HOMEWORK_DIR/workspace"
cp fixtures/homework/policy.json "$HOMEWORK_DIR/policy.json"
bun run dev homework start --workspace "$HOMEWORK_DIR/workspace" \
  --policy "$HOMEWORK_DIR/policy.json" --state "$HOMEWORK_DIR/runs.sqlite" \
  --mode safe --plan --demo 'Fix order calculation. Do not change tests. Run tests.'

RUN_ID=PASTE_PRINTED_RUN_ID
bun run dev homework plan "$RUN_ID" approve --state "$HOMEWORK_DIR/runs.sqlite" --demo
bun run dev homework approve "$RUN_ID" allow --state "$HOMEWORK_DIR/runs.sqlite" --demo
bun run dev homework approve "$RUN_ID" allow --state "$HOMEWORK_DIR/runs.sqlite" --demo
bun run dev homework resume "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite" --demo
bun run dev homework tasks "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework diff "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework rollback "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
```

The first command saves a structured plan and stops. The next commands approve
the plan, then the file write and Bash separately. Substitute `reject` for plan
approval or `deny` for an action to demonstrate refusal. `auto` skips write/Bash
confirmations after policy checks; deletion always requires approval. State and
policy remain outside the workspace. Counters, task evidence and file hashes
survive restarts; uncertain actions stop for explicit resolution.

`--demo` supplies a scripted model boundary while using real files, Bash and
storage. For a real OpenAI-compatible model, set `OPENAI_BASE_URL`, `OPENAI_API_KEY`
and `OPENAI_MODEL` as in [the environment example](fixtures/homework/.env.example),
and omit `--demo`. The [homework guide](docs/homework.md) contains the rubric audit,
all four budget limits, crash injection tests, explicit `resolve` decisions,
unchanged-test checks and rollback conflict demonstrations.

## Development and packaging

```sh
bun run format:check
bun run check
bun test
bun run dev architecture check
bun run benchmark
bun run build
bun run smoke
./dist/vcli --help
```

Builds produce `dist/vcli` for the current host, embedding the layout worker and
graphics font. Distribute the entire `dist/` bundle, including licenses, notices,
the download guide and `WORKFLOWS.md`. CI runs on macOS and Linux, including native
builds and source/compiled pseudoterminal checks outside the checkout. The smoke
suite also checks terminal cleanup, image output and a file-descriptor limit of 256.

Tests use offline fixtures and local provider servers; they do not establish live
provider completion rates or paid-token savings. Manual verification in real
terminal applications and WSL remains incomplete. Native Windows, browser/IDE
services, subscription login, background/write/custom agents and deeper language
analysis are deferred.

The [architecture guide](docs/architecture.md) describes the contracts and package
boundaries. [Research notes](docs/research.md) record the independent design sources.
Formatting is automated, commands and tools have focused modules, and the core
imports neither terminal libraries, provider SDKs nor Bun APIs.

## Documentation

| Guide                                                       | Contents                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [Downloaded build quick start](docs/artifact-quickstart.md) | Onboarding and startup troubleshooting                          |
| [Architecture](docs/architecture.md)                        | Contracts, package boundaries, graphs and durable state         |
| [Local workflows](docs/local-workflows.md)                  | Planning, memory, tasks, explorers, hooks and checkpoints       |
| [Coding-agent homework](docs/homework.md)                   | Rubric audit, exercise, policy, approvals, budgets and rollback |
| [Integrations](packages/integrations/README.md)             | Skills, plugin manifests and MCP configuration                  |
| [Extension compatibility](docs/extension-compatibility.md)  | Supported formats, catalogs and remaining gaps                  |
| [Validation](docs/validation.md)                            | Automated evidence and real-terminal checks                     |
| [Benchmarks](docs/benchmarks.md)                            | Reproducible offline context estimates                          |
| [Research](docs/research.md)                                | Public references and independent implementation scope          |
