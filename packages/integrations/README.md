# Integrations

The package imports reusable skills and MCP servers from Agent Plugins 1.0.0, Claude Code, Codex compatibility packages, Gemini CLI and Qwen Code extensions, and Qoder packages. Installation copies a snapshot and never executes hooks, scripts, or MCP programs. MCP connections start only when discovery is requested.

```ts
import { PluginManager, McpManager, loadSkill } from "@vcli/integrations";

const plugins = new PluginManager(stateRoot);
await plugins.install("https://github.com/team/extensions.git", {
  revision: "a-commit-or-ref",
  subdir: "plugins/architecture",
});
const installed = await plugins.list();
const metadata = installed.flatMap((plugin) => plugin.skills);
const instructions = await loadSkill("architecture:inspect", metadata);

const mcp = new McpManager(installed.flatMap((plugin) => plugin.servers));
for (const tool of await mcp.discover()) registry.register(tool);
await mcp.disconnect();
```

`loadPlugin(root, { dataRoot?, workspaceRoot?, format?, marketplaceManifest?, marketplaceStrict? })` returns metadata, normalized servers, and `unsupported` diagnostics without executing package code. `loadSkill(skill)` or `loadSkill(name, metadata)` returns the selected complete `SKILL.md`; names may be qualified as `plugin:skill`. Plugin imports use bundled schemas, resolved path containment, namespaced servers, and bounded frontmatter reads. Vendor tool filtering directives disable that server when they cannot be honored.

Format descriptors in `formats.ts` define package detection and transport conventions. Multiple manifests require explicit `format`; the installer retains this choice. Catalog normalization lives in `catalogs.ts`, independently of snapshot acquisition and MCP execution. There are no repository-specific compatibility branches.

`PluginManager.list({ workspaceRoot? })` resolves workspace substitutions against the requested project. `PluginManager` supports `install`, `list`, `loadSkill`, and `remove`. Git snapshots record the resolved commit SHA; installing without a revision resolves and records the current HEAD once. Existing plugins must be removed before replacement. Local installs are copied snapshots. Package data has a separate persistent directory under the state root.

State writes use an atomic rename. Install, refresh, and removal roll back snapshot changes if the state write fails; removal also restores persistent data. Mutations and reads are serialized within one manager instance. Concurrent processes need an external lock, and abrupt process termination between snapshot and state renames requires recovery from the retained staging directories; the package does not yet provide a crash recovery journal.

Marketplaces use `addMarketplace(name, source, options?)`, `listMarketplaces`, `refreshMarketplace(name)`, `removeMarketplace(name)`, and `installFromMarketplace(marketplace, plugin)`. Catalogs are imported from `.claude-plugin/marketplace.json`, `.codex-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, or root `marketplace.json`. Documented `github`, `url` and `git-subdir` source objects normalize to the same Git acquisition path; local aliases and `metadata.pluginRoot` remain contained. Duplicate identities disable all conflicting entries. Claude entry manifests, skill-path merging and strict conflicts are retained across restarts; package MCP declarations remain authoritative. Local catalog paths must remain inside the catalog root. Refresh is explicit and never changes installed plugins. Registered ChatGPT app IDs and proprietary marketplace/account access are not portable MCP credentials.

`McpManager` uses the official MCP TypeScript client v2 with stdio and Streamable HTTP, automatic modern/legacy protocol negotiation, bounded discovery pagination, and explicit resource listing/reading. Imported tools are deferred (`eager: false`), carry provider-safe hashed names, and use `kind: execute`; server permission annotations are advisory. The host registry validates arguments and applies permissions. A failed or cancelled call disconnects that server and is never replayed; `reconnect(serverName)` only reopens the connection and rediscovers metadata. Full results, including images and resource links, are retained in `fullOutput` while model-facing text is bounded.

Do not print normalized server environment variables or headers: native configuration substitution may resolve credentials. Interactive OAuth setup, legacy SSE, vendor hooks, commands, agents, policies, and host UI features are currently reported as unsupported.

Source specifications: [Agent Plugins](https://agent-plugins.org/specification), [Agent Skills](https://agentskills.io/specification), [MCP TypeScript client](https://github.com/modelcontextprotocol/typescript-sdk), [Claude plugin manifests](https://code.claude.com/docs/en/plugins-reference), [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins), and [Gemini extension reference](https://geminicli.com/docs/extensions/reference/).

See the [compatibility matrix and remaining work](../../docs/extension-compatibility.md). CLI inspection/listing uses summaries that omit executable configuration and source URLs.
