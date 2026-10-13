import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Skill } from "@vcli/core";
import { containedPath, exists, message, object, validateName } from "./paths.ts";

export const projectSkillLocations = [
  ".vcli/skills",
  ".agents/skills",
  ".claude/skills",
  ".gemini/skills",
  ".qwen/skills",
];

const FRONTMATTER_LIMIT = 16_384;

export async function readSkillMetadata(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(FRONTMATTER_LIMIT);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match)
      throw new Error(`SKILL.md needs YAML frontmatter within ${FRONTMATTER_LIMIT} bytes`);
    return object(Bun.YAML.parse(match[1]!), "Skill frontmatter");
  } finally {
    await file.close();
  }
}

export async function discoverSkills(
  root: string,
  locations: string[],
  plugin: string,
  diagnostics: string[],
): Promise<Skill[]> {
  const found = new Map<string, Skill>();
  const seen = new Set<string>();
  for (const location of locations) {
    try {
      if (!(await exists(join(root, location)))) continue;
      const directory = await containedPath(root, location);
      if (!(await stat(directory)).isDirectory())
        throw new Error(`Skill location is not a directory: ${location}`);
      const paths = (await exists(join(directory, "SKILL.md")))
        ? [join(directory, "SKILL.md")]
        : (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => join(directory, entry.name, "SKILL.md"));
      for (const path of paths) {
        if (!(await exists(path))) continue;
        try {
          const safe = await containedPath(root, path);
          if (seen.has(safe)) continue;
          seen.add(safe);
          const meta = await readSkillMetadata(safe);
          const name = validateName(meta.name, "Skill name");
          if (name.includes(".")) throw new Error(`Skill name ${name} cannot contain dots`);
          const expectedName = dirname(safe) === root ? plugin : basename(dirname(safe));
          if (name !== expectedName) throw new Error(`Skill name ${name} must match its directory`);
          if (
            typeof meta.description !== "string" ||
            !meta.description.trim() ||
            meta.description.length > 1024
          ) {
            throw new Error(`Skill ${name} needs a description of 1–1024 characters`);
          }
          if (found.has(name)) throw new Error(`Duplicate skill name: ${name}`);
          found.set(name, { name, description: meta.description.trim(), path: safe, plugin });
          if (meta["allowed-tools"] !== undefined)
            diagnostics.push(
              `Skill ${name}: allowed-tools is advisory; vcli permissions still apply`,
            );
          if (meta.context !== undefined || meta.agent !== undefined)
            diagnostics.push(`Skill ${name}: vendor subagent/context directives are unsupported`);
        } catch (error) {
          diagnostics.push(`Skill ${path}: ${message(error)}`);
        }
      }
    } catch (error) {
      diagnostics.push(message(error));
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Loads instructions only when selected. A name requires the caller's metadata catalog. */
export async function loadSkill(
  target: Skill | string,
  skills: readonly Skill[] = [],
): Promise<string> {
  let selected: Skill | undefined;
  if (typeof target !== "string") selected = target;
  else {
    const matches = skills.filter(
      (skill) => skill.name === target || `${skill.plugin}:${skill.name}` === target,
    );
    if (matches.length > 1) throw new Error(`Ambiguous skill ${target}; use plugin:skill`);
    selected = matches[0];
    if (!selected && !target.includes("/") && !target.includes("\\"))
      throw new Error(`Unknown skill: ${target}`);
  }
  const path = selected?.path ?? (target as string);
  const safe = await realpath(path);
  if (basename(safe) !== "SKILL.md") throw new Error("Skill path must point to SKILL.md");
  // Revalidate metadata and package containment after discovery (including changed symlinks).
  if (selected && safe !== selected.path) throw new Error("Skill path changed after discovery");
  await readSkillMetadata(safe);
  return readFile(safe, "utf8");
}
