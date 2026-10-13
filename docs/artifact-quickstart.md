# Start the downloaded vcli

Run the executable against the source folder you want to work on:

```sh
./vcli --root /path/to/your/project
```

Opening vcli inside the extracted download folder starts the welcome screen.
Choose **Open project**. That folder contains
the executable and licenses, so it does not have a source architecture to display.

Choose **Connect provider** to select OpenAI, Anthropic, Gemini, OpenRouter
or an OpenAI-compatible endpoint, enter a model ID and configure an API key.
Key entry is masked. You can keep it for this launch or explicitly save it on this
device in a user-only, unencrypted credentials file. Existing environment keys
work too. Provider setup does not make model calls or verify remote credentials.

Settings are saved for the selected project. API keys stay separate from project
configuration. Subscription logins are not included in this release.

OpenRouter uses its public API endpoint automatically. Use a gateway model ID
from your account and enter the key in setup, or set `OPENROUTER_API_KEY` in your
shell. Setup and history navigation do not spend model tokens.

## Workspace commands

Press **F1** to open the command menu. Press **Esc** to return to the task prompt,
where you can type `/help` and the commands below.

| Command                              | Action                                                |
| ------------------------------------ | ----------------------------------------------------- |
| `/open`                              | Open another source folder                            |
| `/connect`                           | Select a provider, model and API key                  |
| `/tokens`                            | Edit context, response and total task token budgets   |
| `/reasoning`                         | Choose the model's reasoning effort                   |
| `/chat`, `/split`, `/architecture`   | Expand chat, show both, or expand architecture        |
| `/history`, `/sessions`              | Select and resume a saved conversation                |
| `/new`                               | Start a separate conversation                         |
| `/config`                            | Open settings                                         |
| `/permission`                        | Choose YOLO, ask or read-only mode                    |
| `/status`                            | Inspect active configuration and connection readiness |
| `/observed`, `/intended`, `/changes` | Switch architecture views                             |
| `/scan`                              | Reconcile architecture with source files              |
| `/plugins`, `/skills`                | Browse local extension metadata                       |

Describe a coding task in the prompt once connected. **YOLO is the default.**
Graph exploration, setup, help and export use no model tokens.

Press **F2** for full chat and **F3** for full architecture. Your prompt appears
immediately above the streaming response, and previous messages remain available.
Responses display formatted Markdown, including emphasis and code. **Tab** focuses
chat; **Page Up/Down** scroll, **Up/Down** select messages, and **Home/End** jump to
the beginning/latest message. Press **Esc** to return to the prompt. The mouse wheel
also scrolls. `/history` restores conversations after closing and reopening vcli.

Reasoning defaults to the model's native behavior. Explicit effort levels depend
on the chosen model; unsupported levels show a settings error. When a provider
returns reasoning text or a summary, expand its section in the response to read it.
With chat focused, select the response and press **Space** or **Enter** to toggle
the reasoning section. Mouse selection works too.

The canvas uses real images when your terminal reports Kitty or Sixel support.
“Tree fallback” means the detected transport does not support those graphics.

## Local workflows

- `/plan`: explore and preview a design without editing source. Send the planning request after switching modes.
- `/build`: enable implementation under your current permission setting; then ask to implement the plan.
- `/plans`, `/memory`, `/tasks`, `/hooks`: inspect saved plans, project instructions, task progress and hook configuration.
- `/checkpoints`: list captured native file edits. `/rewind <id>` restores one if no later edit conflicts.

Root `AGENTS.md`, `CLAUDE.md` and `.vcli/MEMORY.md` load automatically. Ask the model
to track tasks or delegate a bounded read-only exploration when useful. Explorers
share the parent token budget and cannot edit or run commands. Command hooks use
`.vcli/hooks.json`; the included `WORKFLOWS.md` describes its schema and coverage.
This release does not claim complete compatibility with every Claude Code feature.

## Shell commands

```sh
./vcli --help
./vcli setup --root /path/to/your/project
./vcli run "Inspect the architecture" --root /path/to/your/project --json
./vcli architecture export --format png --root /path/to/your/project
./vcli config show --root /path/to/your/project
./vcli sessions list --root /path/to/your/project
./vcli plugins install /path/to/plugin
```

Keep the accompanying `licenses/` directory and notices with the executable when
redistributing it. This build includes the graphics font and layout worker.

## Startup error mentioning file limits

Bun 1.3.13 can show “possibly due to low max file descriptors (Unexpected)”
for an unrelated startup failure. We reproduced that exact message when the
launch directory's parent was unreadable; the executable also passed scans,
graphics exports and terminal startup with both file limits set to 256.
The warning alone does not identify the cause. See the
[Bun error handler](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/crash_handler.zig#L697-L731).

From the extracted download folder, test startup in an accessible directory:

```sh
vcli_binary="$PWD/vcli"; (cd /tmp && "$vcli_binary" --help)
```

Paste this as one line. If zsh reports “no such file or directory,” reopen the
extracted folder in a fresh terminal and check its location and executable:

```sh
/bin/pwd -P; /bin/ls -l ./vcli
```

That error means the saved executable path does not resolve, so the runtime
has not been tested by that attempt.

If help works, launch from there with an absolute project path:

```sh
(cd /tmp && "$vcli_binary" --root /absolute/path/to/your/project)
```

This changes only the working directory of that launch. If the workspace starts,
check access to the original launch folder. On macOS, this can include the
terminal application's Files and Folders permissions for Downloads or Desktop.
If the error persists, include the build's Actions run, macOS version and whether
the help command above failed when reporting it.
