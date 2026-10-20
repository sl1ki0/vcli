# Durable coding runs

These capabilities belong to the ordinary `vcli run` and chat runtime. There is
one agent loop, one session/run ID and one set of budgets. YOLO remains the default.
No separate homework command, execution engine or provider is needed.

## Install and run

Install Bun 1.3.13, Bash, ripgrep and Python 3 for the example. From this repository:

```sh
bun install --frozen-lockfile
bun run dev setup
bun run dev run "Find and fix the failing tests" --root /path/to/project
```

Choose a provider and model explicitly through setup. API keys remain in the
credential store or environment, outside project settings. For a local compatible
endpoint, use `--provider compatible --model <model> --endpoint <url>` and set
`VCLI_COMPATIBLE_API_KEY`; the regular compatible provider supports tool calling.

The model chooses calls from JSON Schemas. `files_list`, `files_search` and
`files_read` inspect the project; `files_patch` creates/replaces exact spans or
files; `files_delete` removes a regular file. `shell_run` executes Bash with an
explicit `cwd`, timeout and output cap and returns stdout, stderr and exit code.
Other tools are discovered through `tools_search`; full outputs are local
artifacts. Invalid schemas are rejected before approval or execution.

## Optional external policy

Without a policy, the usual permission modes and general Bash workflows remain
available. Native file tools always reject traversal, links and paths outside the
project. Private `.vcli` configuration/state and `.git` are inaccessible to them.

Use `--policy /path/to/policy.json` or `VCLI_POLICY` to enable explicit allowlists.
The policy must live outside the mutable project. A portable working example is
[`fixtures/order/policy.json`](../fixtures/order/policy.json), whose workspace is
the adjacent `workspace/` directory:

```json
{
  "version": 1,
  "commands": {
    "allow": ["python3 -m unittest -v"],
    "deny": ["rm -rf ."]
  },
  "directories": { "allow": ["."], "deny": ["private"] }
}
```

Directory rules are relative to the workspace, or canonical absolute paths inside
it. Runtime canonicalizes and rechecks each path and cwd, including command path
arguments. Deny wins; unspecified commands/directories are denied. Bash commands
must match an exact allowed string and use simple syntax: no pipes, substitution,
redirects, nested shells or interpreter code arguments. MCP startup is disabled in
this restricted profile. Configured command hooks obey the same command policy.
The policy binding persists with the run and cannot be dropped on resume.

| Mode                     | Read      | Write/Bash        | Deletion under strict policy |
| ------------------------ | --------- | ----------------- | ---------------------------- |
| `ask` (`safe`)           | Immediate | Durable approval  | Durable approval             |
| `yolo` (`auto`, default) | Immediate | Allowed by policy | Durable approval             |
| `read-only` / Plan Mode  | Immediate | Denied            | Denied                       |

Command allowlists are not OS process isolation: an allowed test program still
runs with the user's rights. Use a disposable project without secrets.

## Plans, tasks and approvals

```sh
vcli run "Inspect and plan the change" --plan
vcli plan show RUN_ID
vcli plan approve RUN_ID
vcli sessions resume RUN_ID
# Or approve and resume explicitly:
vcli sessions resume RUN_ID --build
```

`plan_publish` stores the goal, ordered tasks, tools, dependencies, risks,
assumptions and completion criteria. A plain final answer is insufficient for
Plan Mode. Planning calls are read-only; hooks, shell, edits and MCP startup are
blocked before effects. Approval changes the plan decision, not tool permissions.
Use `vcli plan reject RUN_ID` to reject it and retain planning restrictions.

In chat, the plan appears as a formatted progress card. `/plan show` reveals it;
`/plan visual` opens the dependency view. `/plan approve`, `/plan reject` and
`/build` make local decisions without inference. `/tasks` shows task progress.

`plan_task` starts a ready task or verifies it using recorded successful tool-call
IDs. Runtime assigns implementation calls to the current task and refuses blocked
dependencies. Completion requires a successful call of the declared verification
tool; a model's textual claim cannot mark work complete. States and evidence
survive restart. `vcli sessions tasks RUN_ID` inspects them without a model.

In ask mode, an approval is persisted before effects. An interactive run shows the
approval menu. A headless run stops with `awaiting-approval`; decide it offline:

```sh
vcli sessions show RUN_ID
vcli sessions approve RUN_ID CALL_ID   # or: deny
vcli sessions resume RUN_ID
```

Denial is returned as a tool result so the model can choose another action. Tool
contracts are checked again before execution; an old decision cannot authorize a
changed contract. Pending approvals and recorded denials survive resume even when
the new launch uses the default YOLO configuration. Reads with hooks or lazy process startup are treated as compound
actions and include those effects in authorization and budget checks.

## Budgets and recovery

| Counter             | Default |
| ------------------- | ------: |
| Model requests      |     400 |
| Tool calls          |   2,000 |
| Side-effect actions |   1,000 |
| Tool result bytes   |  64 MiB |

Set `runLimits.modelRequests`, `runLimits.toolCalls`, `runLimits.sideEffects` or
`runLimits.resultBytes` using `vcli config set`. Existing token/context settings
remain independent limits. A run retains its original limits and counters across
planning, approval, resume and retries. Whole batches reserve capacity atomically:
if any limit cannot cover a batch, none of its calls executes. Unknown outputs get
a byte allowance and explicit incomplete markers when capped. Explorer requests,
tool calls and output share the parent budget as well as its token allowance.
Missing outcomes retain conservative charges.

Each side effect has a durable start and result. Completed call IDs return their
saved results; reusing an ID with different arguments is a protocol error. After
a crash between execution and result persistence, runtime stops with `uncertain`.
Inspect the detected tree changes, then explicitly resolve it:

```sh
vcli sessions diff RUN_ID
vcli sessions resolve RUN_ID CALL_ID fail attribute
vcli sessions resume RUN_ID
```

Resolutions are `retry`, `fail` or `abort`. Retry is available only for operations
with explicitly repeatable semantics; arbitrary mutations and Bash are not safe
retries. File-changing uncertain calls also require `attribute` or `discard` to
decide whether the detected changes belong to this run. Discarding attribution
leaves the actual files in place. Interrupted rollback is resolved before another
rollback attempt. No uncertain action is silently replayed.

## Run diff and rollback

```sh
vcli sessions diff RUN_ID
vcli sessions rollback RUN_ID
```

The journal saves the full allowed project tree before each mutating action and
the actual result afterward, including Bash, hooks, creation and deletion. Original
bytes/modes, final bytes/modes and hashes persist outside the project. Before the
next mutation, an unexpected external edit stops the action. Rollback checks all
touched paths, policy and hashes before replacing any file; one conflict prevents
all replacements. Untouched files are preserved. The journal works after restart
and repeated completed rollback is idempotent.

Explicit exclusions: `.git`, `.vcli` private metadata, `node_modules`, `dist`,
`coverage`, `.cache`, `.venv`, `__pycache__`, `.env` and `.env.*`. Policy-denied
directories are outside the mutable scope and are never read into the journal.
The example's `order.py` and `test_order.py` are included. Native single-edit
checkpoints remain available separately through `/checkpoints` and `/rewind`.
External service effects are not reversible. Snapshots fail closed above 20,000
files or 128 MiB; they never silently drop additional source files.

Session SQLite and artifacts default to protected `.vcli` directories. Use
`--state-dir /external/directory` or `VCLI_STATE_DIR` to keep run state, plan
artifacts and journals externally; supply the same location on later commands.
Legacy project tasks/checkpoints remain in protected project metadata. Journal
storage otherwise defaults to `~/.local/state/vcli/journal/<project-hash>`.

## Reproducible order example

Copy the intentionally broken fixture to a disposable directory; leave its tests
unchanged. The policy stays outside that workspace:

```sh
cp -R fixtures/order/workspace /tmp/vcli-order-workspace
vcli run "Fix the order total so tests pass. Do not change tests. Find the files, fix the code and run python3 -m unittest -v through Bash." \
  --root /tmp/vcli-order-workspace --policy "$PWD/fixtures/order/policy.json"
```

For an offline deterministic demonstration of the same production harness,
provider adapter and actual Bash execution:

```sh
bun test tests/run-acceptance.test.ts
bun test packages/core/tests/durable-runtime.test.ts tests/project-policy.test.ts tests/run-journal.test.ts
```

The acceptance test publishes three dependent tasks, proves no planning mutation,
approves the plan, fixes only `order.py`, runs the unchanged tests through Bash,
reopens the run, inspects its diff and restores the original source. Other tests
cover every counter, whole-batch refusal, crash fault points, decisions, forbidden
paths and external-edit rollback conflicts. Scripted providers are deterministic
runtime evidence; they do not establish live model completion rates.
