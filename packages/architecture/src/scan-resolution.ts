import { realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArchitectureEdge, ArchitectureNode } from "@vcli/core";
import { createCompilerResolver } from "./scan-config.ts";
import {
  fileCandidate,
  packageName,
  workspaceEntry,
  workspacePackages,
  type PackageIndex,
} from "./scan-packages.ts";
import type { ParsedFile } from "./scan-syntax.ts";
import { slash } from "./utils.ts";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Resolve imports into observed assets/modules or explicitly unresolved/external nodes. */
export function resolveImports(
  root: string,
  parsed: Map<string, ParsedFile>,
  packages: PackageIndex,
  inventoried: Set<string>,
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  diagnostics: string[],
) {
  const { manifests, owner } = packages;
  const workspace = workspacePackages(manifests, diagnostics);
  const compiler = createCompilerResolver(root, diagnostics);
  const known = new Map<string, ArchitectureNode>();
  for (const node of nodes) {
    if (!node.path || !parsed.has(node.path)) continue;
    const absolute = join(root, node.path);
    known.set(absolute, node);
    try {
      known.set(realpathSync(absolute), node);
    } catch {
      /* Removed during indexing; resolution will diagnose missing dependencies. */
    }
  }
  const external = new Map<string, ArchitectureNode>();
  for (const [path, record] of parsed) {
    const source = known.get(join(root, path))!;
    if (!record.imports.length) continue;
    for (const reference of record.imports) {
      const resolved = compiler.resolve(reference.specifier, join(root, path));
      let target = resolved ? fileCandidate(resolved.resolvedFileName, known) : undefined;
      if (!target && reference.specifier.startsWith("."))
        target = fileCandidate(resolve(dirname(join(root, path)), reference.specifier), known);
      const name = packageName(reference.specifier),
        local = workspace.get(name);
      if (!target && local) {
        const entry = workspaceEntry(local, reference.specifier);
        if (entry) target = fileCandidate(entry, known);
      }
      if (!target) {
        const candidates = [
          resolved?.resolvedFileName,
          reference.specifier.startsWith(".")
            ? resolve(dirname(join(root, path)), reference.specifier)
            : undefined,
        ];
        for (const absolute of candidates) {
          if (!absolute) continue;
          const assetPath = slash(relative(root, absolute));
          if (!inventoried.has(assetPath)) continue;
          target = known.get(absolute);
          if (!target) {
            target = {
              id: `file:${assetPath}`,
              label: assetPath,
              path: assetPath,
              kind: "file",
              parent: owner(assetPath)?.id,
              status: "observed",
            };
            known.set(absolute, target);
            nodes.push(target);
            if (target.parent)
              edges.push({
                id: `contains:${target.parent}->${target.id}`,
                source: target.parent,
                target: target.id,
                kind: "contains",
                status: "observed",
              });
          }
          break;
        }
      }
      if (!target) {
        const relativeReference =
          reference.specifier.startsWith(".") || isAbsolute(reference.specifier);
        const manifest = manifests.find(
          (m) => `package:${slash(relative(root, m.directory)) || "."}` === source.parent,
        );
        const declared = [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ].some(
          (field) =>
            manifest?.value[field] &&
            typeof manifest.value[field] === "object" &&
            Object.hasOwn(manifest.value[field] as object, name),
        );
        const unresolved =
          relativeReference ||
          !!local ||
          (!resolved && !declared && !builtins.has(reference.specifier));
        const id =
          unresolved && relativeReference
            ? `unresolved:${path}:${reference.specifier}`
            : `${unresolved ? "unresolved" : "external"}:${name}`;
        target = external.get(id);
        if (!target) {
          target = {
            id,
            label: relativeReference ? reference.specifier : name,
            kind: "external",
            status: unresolved ? "unresolved" : "observed",
          };
          external.set(id, target);
          nodes.push(target);
        }
        if (unresolved)
          diagnostics.push(
            `Unresolved import ${JSON.stringify(reference.specifier)} in ${path}:${reference.line}`,
          );
      }
      edges.push({
        id: `${reference.kind}:${source.id}->${target.id}:${reference.line}`,
        source: source.id,
        target: target.id,
        kind: reference.kind,
        status: target.status === "unresolved" ? "unresolved" : "observed",
        evidence: [{ path, line: reference.line, endLine: reference.endLine }],
      });
    }
  }
  return compiler.revisionOptions();
}
