# Homework 1: tool-calling coding agent

The `multiagents-homework` branch adds an opt-in `homework` command for the exact
course rubric. The existing architecture/chat CLI remains available. The homework
workflow uses the repository's own provider adapters and a portable runtime; it
uses no agent framework.

## Assessment of the previous CLI

The normal CLI already had model-selected tool calls, JSON Schema validation,
permission modes, durable conversations, read-only planning, token accounting,
dependent tasks, and guarded native-edit checkpoints. Those features alone did
**not** demonstrate a score of 10 under this assignment:

| Rubric requirement  | Previous gap                                                                                                             | Homework workflow                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Agent loop and Bash | No dedicated supplied Python exercise or acceptance demonstration                                                        | Exact `order.py` / `test_order.py` fixture; real Bash verification and unchanged-test assertion |
| Policy and approval | General YOLO/ask permissions were not an external exact-command policy; ask UI did not provide this stop/resume protocol | External policy, canonical path checks, safe/auto modes, durable allow/deny decisions           |
| Crash recovery      | Interrupted mutations were retained without the assignment's explicit fail/retry/abort protocol                          | Durable call identity, attempts, uncertain state, explicit resolution                           |
| Plan Mode           | Read-only planning existed; `/build` did not establish this structured approval contract                                 | Structured saved plan, explicit approve/reject, no side effects before approval                 |
| Grade 8 budgets     | Token accounting did not cover all four required counters and whole-batch admission                                      | Durable model-request/tool-call/side-effect/result-byte counters                                |
| Grade 9 tasks       | Dependency validation existed; completion evidence needed a dedicated rubric contract                                    | Task-bound execution, dependency gating, saved tool evidence, stdout checklist                  |
| Grade 10 journal    | Checkpoints excluded Bash and did not provide a complete run-wide create/edit/delete journal                             | Tree snapshots, diff, conflict detection, guarded rollback after restart                        |

The automated tests exercise these contracts deterministically. `bun run smoke`
also runs the compiled executable in a fresh external project through plan approval,
real Bash verification, task inspection, resume and rollback. Passing them is
reproducible evidence for the rubric, not a guarantee of a particular examiner's
score or a live model's success rate.

## Install and test

Use macOS, Linux, or WSL with **Bun 1.3.13**, **Bash**, and **Python 3.9+** on PATH:

```sh
bun install --frozen-lockfile
bun run test:homework
```

The tests use temporary project copies, scripted provider responses and real local
file/process tools. They do not need network access or a paid API. Run repository
checks separately:

```sh
bun run format:check
bun run check
bun test
bun run dev architecture check
bun run build
bun run smoke
```

## Reproduce the supplied exercise without an API

Keep the committed fixture deliberately broken. Copy it into a disposable project
and keep policy and saved state **outside** that project:

```sh
HOMEWORK_DIR=$(cd "$(mktemp -d)" && pwd -P)
cp -R fixtures/homework/workspace "$HOMEWORK_DIR/workspace"
cp fixtures/homework/policy.json "$HOMEWORK_DIR/policy.json"
shasum -a 256 "$HOMEWORK_DIR/workspace/test_order.py"
bun run dev homework start \
  --workspace "$HOMEWORK_DIR/workspace" \
  --policy "$HOMEWORK_DIR/policy.json" \
  --state "$HOMEWORK_DIR/runs.sqlite" \
  --mode auto --plan --demo \
  'Исправь расчёт итоговой стоимости заказа, чтобы тесты проходили. Тесты не меняй. Сам найди нужные файлы, внеси исправление и запусти тесты.'
```

Save the printed `run_id` as `RUN_ID`. This first command pauses for plan approval.
`--demo` supplies deterministic scripted model responses to the real agent loop. It demonstrates runtime behavior and uses
real Bash to run `python3 -m unittest -v`; it does not claim to measure a model's
ability to discover the fix. The live-model path below uses actual tool calling.

```sh
RUN_ID=PASTE_PRINTED_RUN_ID
bun run dev homework plan "$RUN_ID" approve --state "$HOMEWORK_DIR/runs.sqlite" --demo
bun run dev homework status "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework tasks "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework diff "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
shasum -a 256 "$HOMEWORK_DIR/workspace/test_order.py"
(cd "$HOMEWORK_DIR/workspace" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v)
```

The two `test_order.py` hashes must match. The initial fixture fails both tests;
the repaired copy must pass both. The diff must include the `order.py` fix and no
change to `test_order.py`. The Bash executor sets `PYTHONDONTWRITEBYTECODE=1`, so verification does not create
Python bytecode. The journal includes all regular project files; source files and
tests have no exclusion.

## Use a real model

Choose a service that supports OpenAI-compatible Chat Completions and tool calls.
The CLI reads these environment variables; it does not load `.env` files:

```sh
export OPENAI_BASE_URL=http://localhost:11434/v1/
export OPENAI_API_KEY=ollama
export OPENAI_MODEL=qwen3:4b
```

These are example local-server settings, not a bundled model or an API key for a
hosted service. For an already available educational or corporate endpoint, use
its base URL, key and explicit model ID. No purchase is required by this workflow.
Use a fresh temporary project copy, then repeat `homework start` **without**
`--demo`. Continue its approvals/resumes without `--demo` as well. If using Ollama,
install it separately, prepare the model, and run its server in another terminal.
The example environment is also in `fixtures/homework/.env.example`; never commit
real credentials.

The model receives names, descriptions and JSON Schemas for `list_files`,
`read_file`, `write_file`, `delete_file`, `Bash`, and the plan/task control tools.
`Bash` accepts `command` and `cwd`, executes through Bash, and returns stdout,
stderr and exit code. Tool results retain their original `tool_call_id`.

## Policy and modes

`fixtures/homework/policy.json` is a complete working policy. Directory entries
are resolved relative to the chosen workspace and checked against canonical paths.
The allowlist contains the workspace (`.`); the denylist contains `private`.
Denied directories include their descendants. Deny rules take precedence.

Commands are whole exact simple strings from the executor’s narrow built-in
command families: `python -m unittest` or `python3 -m unittest` (optionally `-v`),
`echo` with simple safe
words, `sleep` with an integer duration, `yes`, `true`, and `false`. Each complete
command must also appear in the policy allowlist. The supplied policy allows
`python3 -m unittest -v`, denies `rm -rf workspace`, and rejects every unlisted
command. Shell pipelines, redirects, substitutions and nested shell execution
are rejected. Changing only the first command word cannot bypass the policy.
Absolute paths, traversal through `..` and escaping symlinks are rejected by file
tools and by the Bash working-directory check. The policy and saved state must
be outside the mutable workspace and cannot be edited by agent tools.

| Mode   | Reads                          | Writes and Bash                           | Deletion                                  |
| ------ | ------------------------------ | ----------------------------------------- | ----------------------------------------- |
| `safe` | Immediate, after policy checks | Save pending action and stop for approval | Save pending action and stop for approval |
| `auto` | Immediate, after policy checks | Immediate, after policy checks            | Save pending action and stop for approval |

Start a fresh copy with `--mode safe --demo`. Each pending dangerous action pauses
the process with its `run_id`. Allow or deny it, continuing the same run:

```sh
bun run dev homework approve "$RUN_ID" allow --state "$HOMEWORK_DIR/runs.sqlite" --demo
# At a later pending action, to demonstrate refusal instead:
bun run dev homework approve "$RUN_ID" deny --state "$HOMEWORK_DIR/runs.sqlite" --demo
```

Approval does not bypass policy. A refusal becomes a tool error with its reason,
so a real model can change its next action. The scripted demo ends after a refusal
and reports it; the automated test verifies that the denied action never started.

The policy is **not process isolation**. Bash and Python run with the user's
permissions. A permitted test runner executes the project's Python, which can
perform arbitrary actions. Use only a disposable educational project without
secrets and trusted executables in the executor’s fixed system PATH. The journal detects changes;
it does not prevent the subprocess from making them. This is the assignment's
explicit process-isolation limitation.

## Plan Mode

Use a fresh project copy with `--plan --demo`. Before approval, only read tools
are allowed. The saved plan contains a goal, ordered task steps, required tools,
risks, assumptions and a readiness criterion. Inspect and approve it:

```sh
bun run dev homework status "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework plan "$RUN_ID" approve --state "$HOMEWORK_DIR/runs.sqlite" --demo
# Alternatively, reject a still-pending plan:
# bun run dev homework plan "$RUN_ID" reject --state "$HOMEWORK_DIR/runs.sqlite" --demo
```

An approved plan remains subject to `safe` confirmations or `auto` policy checks.
Approval does not reset the budget. The automated planning test asserts that no
write, deletion or Bash execution occurs before the decision.

## Resume and uncertain actions

All saved records use the printed `run_id`. Restarting the CLI uses those records:

```sh
bun run dev homework resume "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite" --demo
```

Completed calls return their saved result without repeating the action. Reusing a
call ID with a different name or different arguments is a protocol error. Before
an effect, the runtime durably records its start and resource charges; after the
effect it records the result. A crash between these records leaves an uncertain
call. Resume does not replay it.

Inspect `status` and `diff` first. Use the printed call ID to resolve it explicitly:

```sh
CALL_ID=PASTE_UNCERTAIN_CALL_ID
bun run dev homework resolve "$RUN_ID" "$CALL_ID" fail --state "$HOMEWORK_DIR/runs.sqlite" --demo
# Alternatives for an uncertain call:
# bun run dev homework resolve "$RUN_ID" "$CALL_ID" retry --state "$HOMEWORK_DIR/runs.sqlite" --demo
# bun run dev homework resolve "$RUN_ID" "$CALL_ID" abort --state "$HOMEWORK_DIR/runs.sqlite" --demo
```

Retry is a new attempt of the same call and is allowed only for read tools. Writes,
deletions and Bash require fail or abort because their effects are not safely
repeatable after an uncertain outcome.
If an uncertain action changed the tree, resolution requires the user to attribute
those detected changes explicitly using `--adopt`. This attribution is stored;
rollback remains blocked until uncertainty is resolved. Automated tests inject a
controlled failure after execution and before result persistence.

```sh
# After inspecting diff, explicitly attribute the uncertain attempt's changes:
bun run dev homework resolve "$RUN_ID" "$CALL_ID" fail --adopt --state "$HOMEWORK_DIR/runs.sqlite" --demo
```

## Durable budgets

`start` accepts `--model-requests`, `--tool-calls`, `--side-effects`, and
`--result-bytes`, each with a nonnegative integer limit. `status` shows limits and
spent counters. Defaults are 30 model requests, 80 tool calls, 20 side effects and
262,144 result bytes. For example, a zero model-request budget must stop before inference:

```sh
bun run dev homework start \
  --workspace "$HOMEWORK_DIR/workspace" \
  --policy "$HOMEWORK_DIR/policy.json" \
  --state "$HOMEWORK_DIR/runs.sqlite" --mode auto --demo \
  --model-requests 0 'Inspect the project'
```

The runtime saves reservations atomically with the action state. Planning,
approval, resume and explicit retry share the same counters. Interrupted charges
are retained. If a model returns a batch that cannot fit, no call in that batch
executes. Tools receive the remaining result-byte allowance; truncation is marked
explicitly and prevents unbounded output from entering model context. Tests exhaust
all four budgets and cover batch admission, resume and the charged-but-unsaved-result
failure window.

Side effects are reserved conservatively for the entire proposed batch before
approval. Reservations remain charged even if policy or the user later denies
the action. Result bytes count the UTF-8 tool-result text actually returned to the
model, including an incompleteness marker; local file snapshots are separate
recovery data. Model tokens are additionally reserved before inference, settled
from reported usage, and conservatively retained when usage is missing. Root
instructions are reloaded within a combined 2,000-token estimate on each advance.

## Task checklist and evidence

```sh
bun run dev homework tasks "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
```

Stdout contains a checklist with each task's identifier, description and state.
Tasks have dependencies and a required observable result. Execution calls carry
the current task ID; planning reads are stored separately. A task becomes complete
only after a successful tool result satisfies its required evidence, such as a
Bash result with exit code zero. A model's textual claim alone cannot complete a
task. The deterministic demonstration has at least three tasks and dependent
execution; completed tasks retain their evidence after resume.

## Diff and safe rollback

```sh
bun run dev homework diff "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
bun run dev homework rollback "$RUN_ID" --state "$HOMEWORK_DIR/runs.sqlite"
```

Snapshots are limited to 10,000 regular files and 16 MiB; symlinks, hardlinks and
special files are rejected. The journal captures initial and final bytes, file modes and hashes for created,
modified and deleted project files. Before every potential mutation, the runtime
compares the tree with its saved expected state. After the action, it records the
actual change, including permitted Bash changes. Paths remain in the audit even
when later actions restore their original bytes or create and then delete a file. There are no generated-file exclusions. Python bytecode generation is disabled
for the Bash executor; the exercise source and tests are tracked.

Rollback is an explicit user command, available after a restart. It restores only
paths touched by this run and first checks policy, canonical paths and **all**
affected hashes. If even one affected file has a later external edit, rollback
reports a conflict before restoring any file. Unrelated files are preserved. The
recorded original changes remain visible in `diff` after rollback for audit; the
run status changes to `rolled-back`.
If restoration itself is interrupted or fails, the saved `rolling-back` state
prevents the agent from continuing; inspect the tree before attempting recovery.
Uncertain actions must be resolved before rollback. The rollback tests show the
`order.py` diff, restoration in a new runtime instance, create/delete coverage,
and refusal after an external edit.

## Defense checklist

Show the offline exercise, unchanged test hash, actual Bash exit code and task
checklist; then run the automated suite. Be ready to locate the separate policy
checker, explain a denied call, demonstrate budget exhaustion, resolve the injected
failure, and show rollback conflict handling. The real-provider path establishes
how the model supplies decisions; the offline tests establish runtime invariants.
