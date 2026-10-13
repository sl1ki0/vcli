# Local coding workflows

vcli implements these workflows independently. No source from the leaked Claude Code mirror is included. The reference is Claude Code's public documentation for [planning](https://code.claude.com/docs/en/best-practices), [memory](https://code.claude.com/docs/en/memory), [subagents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks), and [checkpoints](https://code.claude.com/docs/en/checkpointing). Similar workflows do not imply command, manifest, or feature compatibility with every Claude Code release.

## Plan, preview, implement

Use `/plan` to enter planning mode, then send your request normally. The header displays PLAN. The executor denies source edits, commands and external MCP connections, even when your configured permission is YOLO. The model can inspect source and use `architecture_preview` to display a draft component graph. This preview survives scans in the current workspace without changing the versioned architecture document.

Completed plan text is saved to `.vcli/state/plans/<session-id>.md`. `/plans` shows saved plans. Use `/build` and send “Implement the plan” when ready. Build mode uses your existing YOLO, ask or read-only permission setting. Switching modes itself makes no model call. Plans, sessions and derived indexes can be saved in local state while planning; source and the intended architecture document cannot be edited by model tools.

```sh
vcli run "Plan the API boundary change" --plan --json
vcli plans show
vcli sessions resume <id> "Refine verification"          # retains plan mode
vcli sessions resume <id> "Implement the plan" --build
```

Opening a planning conversation from `/history` restores plan mode. A plan does not automatically authorize implementation. Draft graph artifacts remain retrievable in the saved session; restoring its live preview across application restarts is not yet implemented.

## Project memory

Root `AGENTS.md`, `CLAUDE.md` and `.vcli/MEMORY.md` load on each run, including a resumed run. Their combined automatic allocation is 2,000 estimated tokens and counts inside the existing prompt ceiling. `/memory` shows loaded content and truncation diagnostics. Keep root instructions concise; inspect additional files explicitly when needed. Nested path-specific instructions, imports and vendor auto-memory layouts are not automatically interpreted.

The model can discover `memory_read` and `memory_write` to preserve reusable project knowledge. Writes require the revision returned by a preceding read, preventing stale updates. They follow the same permission policy as source writes. `.vcli/MEMORY.md` is a project document, not an ignored private credential store.

## Persistent tasks and explorers

Ask the model to create a task list for substantial work. `tasks_update` creates and updates tasks, while `tasks_list` and `/tasks` show progress. Tasks support pending, in-progress, complete and canceled states plus dependency IDs. A task cannot start or complete until its dependencies complete; missing dependencies and cycles are rejected. Records survive sessions in `.vcli/state/tasks.json`. Atomic writes and a project lock avoid lost concurrent updates. An interrupted writer can leave a lock; its error identifies the lock, which should only be removed after confirming no writer remains active.

`subagent_explore` delegates a bounded research or review task to a fresh model context. Up to two explorers run concurrently. They can read/search/list source, query architecture and retrieve artifacts. They cannot edit, execute shell commands, connect MCP, invoke project command hooks or delegate again. The parent retains responsibility for implementation and verification.

Each explorer defaults to a 12,000-token task allocation, accepts 4,000–24,000 tokens, and has at most six model turns. Allocation is reserved durably from the parent's remaining budget before launch; reported usage and unmeasured reservations count toward that same budget. Cancellation drains child work before closing the store. Findings return as bounded text; full transcripts remain retrievable through artifacts and child sessions. Delegation is optional and costs tokens; direct reads are preferable for simple questions. Write-capable workers, custom agent definitions and persistent background agent teams remain future work.

## File checkpoints and rewind

Built-in `files_patch` edits automatically capture the previous file bytes and mode in ignored `.vcli/state/checkpoints/`. Use `/checkpoints`, then `/rewind <id>`, or:

```sh
vcli checkpoints list
vcli checkpoints restore <id>
```

Restore follows the active permission policy. It restores existing bytes and permissions, or removes a file created by the captured edit. Restore checks the current file against the recorded completed edit and refuses subsequent external changes. Multiple edits to one file must be restored newest first. Pending or uncertain edits cannot be automatically restored; inspect them first. A checkpoint bookkeeping or post-hook failure does not turn a completed patch into a retry request.

Capture covers native file edits inside the project and rejects symbolic links, hard links and paths outside the project. It does not capture shell commands, MCP effects, memory-tool writes or intended-architecture updates. It does not reset Git or rewind conversation history. The launching user's permissions still apply to YOLO shell commands, which remain outside checkpoint coverage.

## Command hooks

Create `.vcli/hooks.json` with vcli's versioned schema:

```json
{
  "version": 1,
  "beforeTool": [
    {
      "name": "check-edit-policy",
      "tools": ["files_patch"],
      "command": "./scripts/check-edit-policy.sh",
      "timeoutMs": 10000
    }
  ],
  "afterTool": [
    {
      "name": "verify-edit",
      "tools": ["files_patch"],
      "command": "./scripts/verify-edit.sh",
      "timeoutMs": 30000
    }
  ]
}
```

`/hooks` or `vcli hooks show` inspects the configuration without running commands. Hooks reload each run. Tool matchers are exact names or `*`. Commands receive a JSON event on standard input containing the tool call, project/session identifiers and, for after hooks, the bounded tool result. Output is capped at 16 KiB per hook. Timeouts and cancellation terminate the command process group.

Before-hook failure blocks the tool. After-hook failure is reported alongside the original outcome without encouraging replay of completed mutations. Hook commands pass through the permission gate, including hooks triggered by a read tool. In read-only and plan modes they are denied; in ask mode they require approval. Configured command hooks serialize tool batches because even a hook attached to a read can mutate files. Invalid manifests fail closed. This release supports beforeTool and afterTool, not vendor hooks, prompt hooks or every Claude lifecycle event. Hook scripts should not print credentials.

## Discovery and review

Use `tools_search` to expose workflow tool schemas only when needed. The initial tool schema budget remains 4,000 estimated tokens. Local tool discovery continues to work in plan/read-only mode without starting configured MCP servers. `files_list` supports a ripgrep glob; `git_diff` reviews staged or unstaged changes with external diff programs and text conversion disabled. Large outputs retain artifact handles instead of filling model context.

Tool requests, results and errors also remain in the chat as expandable cards.
Each card shows the action, target and execution state; argument/permission errors
appear even when execution never started. Space/Enter expands the selected card,
F opens its saved result, and Left/Right pages through long output. These local
views make no model calls. Cards use bounded previews with masked credential
fields and literal terminal controls; full result artifacts stay separate from
provider context. Saved sessions restore cards without replaying tool effects.

The runtime stops after three requests with the same argument-validation problem
for one tool, even if unrelated argument fields change. Valid arguments clear that
tool's prior failures; permission refusals, command failures and hook failures
do not count as argument errors. The durable stop prevents empty resume from
spending another inference request. Send a new human message to reset the limit.
Any remaining calls in the stopped batch receive blocked results rather than
performing mutations; already-running reads drain before the task closes.

## Scope of this release

| Local capability                                                          | Current support                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Streaming formatted chat, history, provider/reasoning settings            | Implemented                                                                                         |
| Source tools, shell cancellation, skills, MCP, portable plugin components | Implemented; ecosystem-specific components have compatibility reports                               |
| Read-only planning and architecture preview                               | Implemented; live draft restoration across restarts remains open                                    |
| Persistent instructions and project memory                                | Root files and revision-checked project notes; nested rules/imports remain open                     |
| Subagents                                                                 | Bounded concurrent read-only explorers; background/write workers and custom definitions remain open |
| Tasks                                                                     | Persistent dependency-aware checklist; detached process monitoring remains open                     |
| Hooks                                                                     | Before/after tool commands; additional lifecycle and vendor schemas remain open                     |
| Checkpoints                                                               | Guarded per-file undo; conversation rewind and all-process snapshots remain open                    |
| Terminal architecture canvas                                              | Intended/observed/change views, graphics, tree fallback and export                                  |
| Hosted sessions, subscription account login, IDE services                 | Outside the selected local CLI scope                                                                |

This is an expanded local harness, not a claim of complete Claude Code parity. Remaining compatibility work should be implemented against public contracts with acceptance tests, without copying proprietary source or silently accepting unsupported vendor configuration.
