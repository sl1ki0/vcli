# Extension compatibility

vcli supports reusable skills and MCP configuration across package ecosystems.
Importing a plugin does not imply that the original host's full runtime is present.
Format descriptors, catalog normalization, snapshot management, skill loading and
MCP execution are separate responsibilities in `packages/integrations`.
There is no allowlist of individual repositories or marketplace brands.

## Package formats

| Package                      | Manifest                                   | Skills                           | MCP                                             |
| ---------------------------- | ------------------------------------------ | -------------------------------- | ----------------------------------------------- |
| Agent Plugins 1.0.0          | `plugin.json` with the canonical v1 schema | Agent Skills                     | `mcp.json`, stdio / Streamable HTTP             |
| Claude Code                  | `.claude-plugin/plugin.json`               | Default and declared skill paths | `.mcp.json`, declared files or inline servers   |
| Codex compatibility packages | `.codex-plugin/plugin.json`                | Default and declared skill paths | `.mcp.json`, declared files or inline servers   |
| Gemini CLI                   | `gemini-extension.json`                    | `skills/`                        | Inline servers; `httpUrl` means Streamable HTTP |
| Qwen Code                    | `qwen-extension.json`                      | Default and declared skill paths | Inline servers; `httpUrl` means Streamable HTTP |
| Qoder                        | `.qoder-plugin/plugin.json`                | `skills/`                        | `.mcp.json`                                     |
| Standalone skills            | `SKILL.md`, or a `skills/` directory       | Agent Skills                     | No implicit server discovery                    |

Project discovery searches `.vcli/skills`, `.agents/skills`, `.claude/skills`,
`.gemini/skills` and `.qwen/skills`. Skill bodies load on selection rather than
entering every model prompt. Skill names follow the shared Agent Skills naming
rules; arbitrary vendor frontmatter is not translated into host behavior.

Packages containing several recognized manifests require `--format` to choose
one explicitly. The installed format and native manifest requirement persist
across reloads; losing a native manifest disables the package rather than switching
to a catalog fallback. An invalid manifest
never silently falls through to another format. `vcli plugins formats` lists the
recognized formats. Inspect a local package before installation:

```sh
vcli plugins inspect ./extension
vcli plugins inspect ./multi-host-extension --format qwen
vcli plugins install ./multi-host-extension --format qwen
```

These commands read metadata without running package hooks, installation scripts,
MCP programs or model calls. Public summaries omit server arguments, environment,
HTTP headers and source URLs. Normalized configurations returned by the library
are for execution and may contain resolved secrets; callers must not serialize them.

## Marketplace catalogs

Catalog discovery recognizes `.claude-plugin/marketplace.json`,
`.codex-plugin/marketplace.json`, `.agents/plugins/marketplace.json` and root
`marketplace.json`. Register any local catalog directory or Git repository:

```sh
vcli plugins marketplace add team https://git.example.org/team/catalog.git --ref COMMIT_SHA
vcli plugins marketplace list
vcli plugins install design --marketplace team
vcli plugins marketplace refresh team
```

The catalog adapter supports relative directory sources, `github`, `url`,
`git-subdir`, and the existing `git`, `repository`, `directory` and `local`
aliases. A `git-subdir` source accepts a Git URL or GitHub `owner/repo` shorthand.
The catalog's `metadata.pluginRoot` can resolve bare directory names. Relative
paths and symlinks must remain inside the catalog snapshot. Catalog and package
names must match. Sources are resolved
from the marketplace root, not the hidden manifest directory.

Git commits are recorded on acquisition; `sha` takes precedence over `ref`.
Malformed entries produce diagnostics without hiding valid siblings. Duplicate
names disable every conflicting entry. Names retain vcli's lowercase 1–64 character
identifier policy; some vendor names may need repackaging.

For Claude catalogs, a missing package manifest uses the catalog entry as its
manifest. When a package has a manifest, its MCP declarations are authoritative;
entry MCP declarations are reported as ignored. With default `strict: true`, entry
skill paths append to package skill paths. With `strict: false`, entry component
declarations conflict with a package manifest and installation fails. Unsupported
host components stay visible as diagnostics and never execute.

Marketplace refresh replaces only the catalog snapshot. It does not silently
update installed packages. Installed catalog component metadata is retained, so
restart and later catalog refresh do not change installed skill/server definitions.

## Runtime behavior

MCP uses the official client with stdio and Streamable HTTP. Discovery is lazy,
permission gated and disabled in plan/read-only mode. Server names receive the
plugin namespace exactly once. Workspace substitutions use the requested project
root when a host supplies it. Malformed types and conflicting transports disable
the affected server without coercing values; valid sibling skills remain usable.
Damaged installed packages are disabled independently with a diagnostic, so healthy
plugins remain available and chat can start. Reload revalidates repaired packages.
Installation still rejects invalid package identities and manifests.
Vendor trust flags cannot grant permissions. Unsupported vendor tool filters
continue to disable the server rather than widen its declared access.

Selected tools still pass normal argument validation, permissions and durable
execution recording. Cancelled or uncertain effects are never automatically
replayed. Package installation is a snapshot copy; dependencies are not installed.

## Remaining work

- Archive and npm acquisition, standalone HTTP catalog URLs, registry search and
  discovery galleries. These need bounded downloads, integrity verification and
  contained extraction without lifecycle scripts before activation.
- Legacy SSE and interactive OAuth, with credentials scoped to each server.
- Vendor commands, agents, hooks, policies, settings prompts, context files,
  dependencies, workflows, channels, apps and host UI features. These require
  explicit capability adapters and semantic tests; copying their files does not
  make their execution behavior compatible.
- Process-wide installation locking and a crash recovery journal. Current state
  writes are atomic with rollback on caught failures, but serialization is within
  one manager instance. Concurrent installer processes require an external lock.
- Live third-party package conformance. Local fixtures verify format and runtime
  contracts without paid APIs; they do not prove every marketplace package works.

Add a new ecosystem through a format descriptor or explicit component adapter,
with offline conformance fixtures and a documented support boundary. Keep source
acquisition separate from capability normalization and permissions. Unsupported
semantics must be visible before claiming compatibility.

## Public references

- [Agent Plugins specification](https://agent-plugins.org/specification)
- [Agent Skills specification](https://agentskills.io/specification)
- [Claude marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Gemini extension reference](https://geminicli.com/docs/extensions/reference/)
- [Qwen extension reference](https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/)
- [Qoder plugin layout](https://docs.qoder.com/cli/sdk/plugins)
