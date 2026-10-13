import { join } from "node:path";
import { discoverSkills, PluginManager } from "@vcli/integrations";
import { configHome } from "./config.ts";
import { SqliteSessionStore } from "./store.ts";
import { inspectWorkflow, type WorkflowInspection } from "./workflows/inspection.ts";

/** Read-only workspace panels. They discover metadata without connecting MCP or a model. */
export async function inspectWorkspace(
  root: string,
  topic: "sessions" | "plugins" | "skills" | WorkflowInspection,
): Promise<string> {
  if (topic !== "sessions" && topic !== "plugins" && topic !== "skills")
    return inspectWorkflow(root, topic);
  if (topic === "sessions") {
    const store = await SqliteSessionStore.open(root);
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

  const plugins = await new PluginManager(join(configHome(), "extensions")).list();
  if (topic === "plugins")
    return plugins.length
      ? plugins
          .map(
            (plugin) =>
              `${plugin.name} · ${plugin.skills.length} skills · ${plugin.servers.length} MCP servers\n${plugin.unsupported.length} unsupported components\n`,
          )
          .join("\n")
      : "No plugins installed.\nInstall from your shell: vcli plugins install <path-or-git-source>\nBrowse catalogs: vcli plugins marketplace list";

  const diagnostics: string[] = [];
  const local = await discoverSkills(
    root,
    [".vcli/skills", ".agents/skills", ".claude/skills", ".gemini/skills"],
    "project",
    diagnostics,
  );
  const skills = [...local, ...plugins.flatMap((plugin) => plugin.skills)];
  return [
    skills.length
      ? skills.map((skill) => `${skill.plugin}:${skill.name}\n${skill.description}\n`).join("\n")
      : "No skills found.\nAdd a SKILL.md in .vcli/skills/<name>/ or install a skill plugin.",
    ...diagnostics,
  ].join("\n");
}
