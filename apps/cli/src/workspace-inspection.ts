import { join } from "node:path";
import { discoverSkills, PluginManager, projectSkillLocations } from "@vcli/integrations";
import { configHome } from "./config.ts";
import { SqliteSessionStore } from "./store.ts";
import { inspectWorkflow, type WorkflowInspection } from "./workflows/inspection.ts";
import type { Session } from "@vcli/core";

/** Read-only workspace panels. They discover metadata without connecting MCP or a model. */
export async function inspectWorkspace(
  root: string,
  topic: "sessions" | "plugins" | "skills" | WorkflowInspection,
  session?: Session,
  options: { directory?: string } = {},
): Promise<string> {
  if (topic !== "sessions" && topic !== "plugins" && topic !== "skills")
    return inspectWorkflow(root, topic, session);
  if (topic === "sessions") {
    const store = await SqliteSessionStore.open(root, { ...options, readOnlySnapshot: true });
    try {
      const sessions = await store.list(root);
      return sessions.length
        ? sessions
            .map(
              (session) =>
                `${session.id} · ${session.status}\n${session.ledger.goal.slice(0, 500)}\n${session.provider} / ${session.model} · ${session.usage.input + session.usage.output} tokens\nResume from your shell: vcli sessions resume ${session.id}\n`,
            )
            .join("\n")
        : "No sessions in this project yet.\nConnect a provider, then describe a task in the prompt.";
    } finally {
      store.close();
    }
  }

  const plugins = await new PluginManager(join(configHome(), "extensions")).list({
    workspaceRoot: root,
  });
  if (topic === "plugins")
    return plugins.length
      ? plugins
          .map((plugin) =>
            [
              `${plugin.name} · ${plugin.ecosystem}${plugin.disabled ? " · disabled" : ""} · ${plugin.skills.length} skills · ${plugin.servers.length} MCP servers`,
              ...plugin.unsupported.map((reason) => `Unsupported: ${reason}`),
              "",
            ].join("\n"),
          )
          .join("\n")
      : "No plugins installed.\nInstall from your shell: vcli plugins install <path-or-git-source>\nBrowse catalogs: vcli plugins marketplace list";

  const diagnostics: string[] = [];
  const local = await discoverSkills(root, [...projectSkillLocations], "project", diagnostics);
  const skills = [...local, ...plugins.flatMap((plugin) => plugin.skills)];
  return [
    skills.length
      ? skills.map((skill) => `${skill.plugin}:${skill.name}\n${skill.description}\n`).join("\n")
      : "No skills found.\nAdd a SKILL.md in .vcli/skills/<name>/ or install a skill plugin.",
    ...diagnostics,
  ].join("\n");
}
