# Security audit 2026 10 21

The audit repaired concrete ways to cross credential, directory, permission,
recovery and resource boundaries. Three subagents using the parent model reviewed
independent areas, implemented offline reproductions and fixes, and reviewed
selected changes from another owner. Work is isolated on
`codex/security-audit-2026-10-21`, starting at `d257667`.

Permission gates remain application controls. Authorized Bash, hooks and MCP
programs run with the user's OS rights. This release does not provide filesystem,
network or deliberately detached process isolation at OS level.

## Scope and approach

Coverage included runtime/context/budgets, permissions/configuration, native
source/Git/ripgrep/Bash tools, hooks, memory, tasks, plans, checkpoints, journals,
SQLite/artifact storage, provider credentials/adapters, skills/plugins/MCP,
architecture scanning, terminal output and approval presentation. Fixtures use
synthetic secrets and local HTTP/process services without paid model APIs.

Model arguments, repository content, project settings, plugin metadata, schemas
and tool responses were treated as potentially hostile. Each confirmed finding
was linked to a source path and regression. Host controls were tested independently
of model compliance with prompt instructions.

The review used [OWASP agentic application risks](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
and [excessive agency guidance](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/?lang=us)
to prioritize privilege expansion, tool misuse, supply-chain input and persistent
state. [MCP security guidance](https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices)
informed startup consent, untrusted servers and credential boundaries. Filesystem
and command findings were assessed against [CWE 367](https://cwe.mitre.org/data/definitions/367.html)
and [CWE 78](https://cwe.mitre.org/data/definitions/78.html).
[OS sandboxing guidance](https://www.anthropic.com/research/claude-code-sandboxing)
informed the distinction between application approvals and process isolation.

## Confirmed findings and fixes

Severity reflects demonstrated vcli impact. Upstream dependency severity is
reported separately from reachable product vulnerabilities.

| Finding                                   | Severity | Failure and fix                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credential destination           | High     | Project endpoint changes inherited vendor environment keys; SDK environment defaults could replace a saved endpoint. Canonical SDK endpoints are explicit, vendor environment keys remain canonical, and compatible environment keys require a matching URL binding.            |
| Remote authless provider                  | High     | A project could select a remote compatible endpoint and receive source context without credential selection. Keyless connections are now loopback-only; remote endpoints require explicit endpoint-specific credentials.                                                        |
| Project permission and spending expansion | High     | Projects could weaken user ask/read-only, raise resource ceilings or clear the token cap. They may now only tighten these settings; prohibited updates fail before writing.                                                                                                     |
| Arbitrary skill path                      | High     | Unknown slash-containing skill names loaded arbitrary filesystem paths. Strings now resolve only through the discovered catalog; selected content is revalidated and bounded.                                                                                                   |
| Instruction and memory links              | High     | Automatic instructions and memory tools followed links to synthetic external private content. Linked/special files and linked memory parents are rejected.                                                                                                                      |
| Local storage redirection and disclosure  | High     | Session/task/plan/artifact/architecture paths followed planted links. Guards reject symlinks, hard links and special files, including SQLite sidecars. Session storage is private; shared external state directories fail without changing their permissions.                   |
| Architecture directory-policy bypass      | High     | Maps and architecture_query exposed denied exported type literals to parent/explorer model requests. Inventory and compiler reads are filtered before access; scoped scans avoid the full-project cache.                                                                        |
| Case-insensitive path bypass              | High     | On macOS, .VCLI bypassed protected .vcli and differently cased paths bypassed denied directories. Existing components now resolve to filesystem identity before comparison; protected names are casefolded.                                                                     |
| Hidden execution in read tools            | High     | Git fsmonitor and environment ripgrep preprocessors executed commands through read tools. Both are disabled; Git also filters protected paths without an external policy.                                                                                                       |
| Checkpoint policy bypass                  | High     | Captured files could be restored after their directory was denied; forged metadata could target protected state. Restore now validates current directory policy and protected paths.                                                                                            |
| Lost uncertain effects                    | High     | A mutation followed by an exception became a completed failure and allowed the next mutation. Exceptions after compound/mutating execution starts now stop as uncertain and retain unknown output charges.                                                                      |
| Process lifetime and cancellation         | High     | Cancellation during cwd validation could still spawn; descendants survived cancellation or normal leader exit. Spawn rechecks cancellation; process groups terminate/drain before results. Background work is unsupported.                                                      |
| Implicit shell startup                    | High     | BASH_ENV and exported functions ran code outside an approved command. Native processes/hooks remove shell startup and injected-function variables.                                                                                                                              |
| Batch output and retry reservation        | Medium   | Batches began without minimum result capacity; resumed retries were charged individually. Whole batches now reserve minimum output and retry costs before calls.                                                                                                                |
| Incomplete usage refunds                  | Medium   | Partial/invalid token counts refunded unmeasured inference. Invalid counters are rejected; missing usage components retain conservative reservations.                                                                                                                           |
| Unbounded input and special files         | Medium   | FIFO metadata hung startup; unbounded file/HTTP parsing risked memory exhaustion. Regular-file checks, nonblocking opens, input limits and bounded decoding precede parsing. Compiler reads remain inside the project and outside protected state.                              |
| MCP schemas and startup                   | Medium   | Regex schemas hung validation; schema IDs collided; malformed schemas interrupted siblings; automatic stdio probes started programs twice. External schemas use a constrained dialect and isolated validators; invalid tools are diagnosed separately; stdio startup runs once. |
| Approval and terminal output              | High     | CLI approval hid command tails after 700 characters; raw controls could alter terminal display/clipboard. Approval displays complete escaped arguments; CLI output/errors and approval/card sanitizers neutralize C0/C1 controls and direction marks.                           |
| Explicit task identity                    | Low      | Duplicate-call identity omitted an explicitly supplied taskId despite the protocol error claiming otherwise. Requested identity now persists separately from automatic attribution and participates in duplicate validation across restart.                                     |

Discovered MCP resource list/read operations also retained read-tool classification
after switching to read-only, allowing external calls despite the new mode. They
now require external-action authorization and effect budgets. A regression uses
the actual permission gate to reject both operations after a mode change before
the connector receives a request.

Representative sources and regressions:

- [Provider credentials](../apps/cli/src/credentials.ts),
  [adapter defaults](../packages/providers/src/shared.ts),
  [SDK tests](../packages/providers/tests/credentials.test.ts),
  [configuration/setup tests](../tests/setup.test.ts).
- [Path policy](../apps/cli/src/workflows/policy.ts),
  [process execution](../apps/cli/src/tools/process.ts),
  [policy tests](../tests/project-policy.test.ts),
  [checkpoint tests](../tests/checkpoints.test.ts).
- [State guard](../apps/cli/src/workflows/state-path.ts),
  [storage tests](../tests/storage-security.test.ts),
  [workflow state tests](../tests/workflow-state-security.test.ts),
  [architecture policy test](../tests/architecture-policy.test.ts).
- [Durable runtime tests](../packages/core/tests/durable-runtime.test.ts),
  [MCP schema guard](../packages/integrations/src/mcp-schema.ts),
  [integration tests](../packages/integrations/test/integrations.test.ts),
  [CLI output and PTY tests](../tests/output.test.ts).

Tests include actual Git fsmonitor and ripgrep --pre configurations, FIFO/link
fixtures, SIGTERM-resistant children, parent/explorer requests, real SDK startup
counting and full-tail approval in a PTY. Exploit fixtures use no personal
credentials, configurations, sessions or artifacts. Legacy canonical credentials
remain usable through safe alias lookup.

## Input limits and compatibility

- Native source/checkpoint reads: 16 MiB. Configuration/package JSON and skill
  bodies: 1 MiB; skill frontmatter: 16 KiB. Architecture design: 1 MiB; index: 32 MiB.
- Architecture: 100,000 directory entries, 20,000 files, depth 128, 128 MiB of
  source, 16 MiB of package metadata, 4 MiB of ignore text and 1,000 ignore rules.
  Per source file: 2 MiB; compiler metadata: 1 MiB; ignore file: 64 KiB. Aggregate
  overflow stops scanning explicitly.
- MCP HTTP decoded bodies/aggregated discovery: 8 MiB, at most 64 pages. External
  schemas: 64 KiB, depth 32, 1,024 expanded nodes. Regex/format keywords,
  external/dynamic/cyclic references and unsupported dialect constraints are
  diagnosed rather than silently ignored.
- Provider decoded JSON/SSE/error bodies: 16 MiB. Limit failures cancel the
  underlying response stream and do not trigger an SDK/application retry.
- Stdio selects legacy negotiation instead of disposable startup probes.
  Modern-only stdio needs future explicit protocol selection. HTTP retains
  modern/legacy negotiation.
- VCLI_COMPATIBLE_API_KEY requires matching VCLI_COMPATIBLE_BASE_URL. Remote
  authless services need an intentional endpoint-specific placeholder key.
- New user spending ceilings govern new runs. Resumed runs retain original
  limits/counters. Explicit launch permission overrides remain possible.

## Verification

Reverified baseline: 358 tests and 2,075 assertions. Final macOS arm64 suite:
**456 tests, 0 failures, 2,568 assertions across 50 files**. Frozen installation,
formatting, ESLint, strict TypeScript, architecture drift checks, native build,
standalone smoke outside the checkout and the regenerated offline benchmark pass.
Smoke covers source/compiled PTY flows, graphics, worker/font, restoration,
permissions, cancellation, terminal cleanup and capped descriptors. No paid model
API was used. Dependency audit retains the Braces exception below.

## Dependencies

Initial bun audit reported three advisories across braces 3.0.3 and seroval 1.5.6.
An exact root override upgrades Seroval to 1.6.3, covering the
[thenable deserialization issue](https://github.com/advisories/GHSA-p6vx-979v-rg4c)
and [TypedArray allocation issue](https://github.com/advisories/GHSA-jp82-f5mq-hwhp).
No vcli call to Seroval's untrusted JSON deserializers was found. This is
dependency risk reduction, not a reproduced vcli remote-code-execution claim.
Bun/TypeScript pins and the license preservation workflow remain intact.

The remaining [Braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects development tooling through typescript-eslint → fast-glob → micromatch.
The published advisory lists no patched version; the registry still offers 3.0.3.
No runtime import was found. bun audit still exits nonzero for this development
dependency. An unverified fork or suppressed advisory would not establish a fix.

## Remaining boundaries

Authorized shell commands, hooks and MCP servers can access files and network
destinations with user rights. An allowlisted interpreter/test can execute
project-controlled code; syntax/path checks do not constrain its internal access.
PATH, runtimes and installed executables remain trusted. Deliberately creating a
new POSIX session can escape process-group cleanup. Stronger containment requires
kernel/container/sandbox enforcement.

Static path guards do not eliminate races with a hostile process replacing parent
directories between checks and operations. Default state remains inside the
project and can be altered by shell running with user rights. External private
state and policy preserve application controls; they do not isolate the shell.

Project instructions, hooks, packages, tool descriptions and responses can carry
prompt injection. Host authorization limits effects but cannot prove semantic
user intent. Files readable under the chosen policy may contain secrets. A
successful verification tool proves its recorded result, not natural-language
completion criteria. Linux/WSL and live provider availability need separate runs.
