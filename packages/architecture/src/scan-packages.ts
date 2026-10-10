import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ArchitectureNode } from "@vcli/core";
import { compare, slash } from "./utils.ts";

export interface Manifest {
  path: string;
  directory: string;
  value: Record<string, unknown>;
  text: string;
}
export interface PackageIndex {
  manifests: Manifest[];
  nodes: ArchitectureNode[];
  owner(path: string): ArchitectureNode | undefined;
}

export async function readPackages(
  root: string,
  paths: string[],
  diagnostics: string[],
): Promise<PackageIndex> {
  const manifests: Manifest[] = [];
  for (const path of paths.filter((p) => basename(p) === "package.json")) {
    try {
      const text = await readFile(join(root, path), "utf8"),
        value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected an object");
      manifests.push({
        path,
        directory: dirname(join(root, path)),
        value: value as Record<string, unknown>,
        text,
      });
    } catch (error) {
      diagnostics.push(`${path}: ${(error as Error).message}`);
    }
  }
  const packageNodes: ArchitectureNode[] = manifests.map((m) => ({
    id: `package:${slash(relative(root, m.directory)) || "."}`,
    label: typeof m.value.name === "string" ? m.value.name : basename(m.directory),
    kind: "package",
    path: slash(relative(root, m.directory)) || ".",
    status: "observed",
    evidence: [{ path: m.path, line: 1 }],
  }));
  function owner(path: string): ArchitectureNode | undefined {
    return packageNodes
      .filter((n) => n.path === "." || path.startsWith(`${n.path}/`))
      .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
  }
  for (const n of packageNodes) if (n.path !== ".") n.parent = owner(dirname(n.path!))?.id;
  return { manifests, nodes: packageNodes, owner };
}

export function workspacePackages(
  manifests: Manifest[],
  diagnostics: string[],
): Map<string, Manifest> {
  const workspace = new Map<string, Manifest>();
  for (const manifest of manifests) {
    if (typeof manifest.value.name !== "string") continue;
    if (workspace.has(manifest.value.name))
      diagnostics.push(`Duplicate workspace package name: ${manifest.value.name}`);
    else workspace.set(manifest.value.name, manifest);
  }
  return workspace;
}

export function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const condition of ["types", "import", "require", "default"]) {
      const target = exportTarget(object[condition]);
      if (target) return target;
    }
  }
  return undefined;
}

export function workspaceEntry(manifest: Manifest, specifier: string): string | undefined {
  const name = manifest.value.name as string;
  const subpath = specifier.slice(name.length).replace(/^\//, "");
  const exports = manifest.value.exports;
  if (exports !== undefined) {
    if (
      typeof exports === "object" &&
      exports !== null &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((key) => key.startsWith("."))
    ) {
      const entries = exports as Record<string, unknown>;
      const key = subpath ? `./${subpath}` : ".";
      const exact = exportTarget(entries[key]);
      if (exact) return join(manifest.directory, exact);
      for (const pattern of Object.keys(entries).sort(compare)) {
        if (!pattern.includes("*")) continue;
        const [start, end] = pattern.split("*");
        if (key.startsWith(start!) && key.endsWith(end!)) {
          const target = exportTarget(entries[pattern]);
          if (target)
            return join(
              manifest.directory,
              target.replaceAll("*", key.slice(start!.length, key.length - end!.length)),
            );
        }
      }
      return undefined;
    }
    return subpath
      ? undefined
      : exportTarget(exports)
        ? join(manifest.directory, exportTarget(exports)!)
        : undefined;
  }
  if (subpath) return join(manifest.directory, subpath);
  for (const field of ["source", "types", "module", "main"]) {
    if (typeof manifest.value[field] === "string")
      return join(manifest.directory, manifest.value[field] as string);
  }
  return join(manifest.directory, "index");
}

export function fileCandidate(
  path: string,
  known: Map<string, ArchitectureNode>,
): ArchitectureNode | undefined {
  const candidates = [
    path,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"].map(
      (e) => `${path}${e}`,
    ),
    ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.d.ts"].map((e) => join(path, e)),
  ];
  // TypeScript source uses .js specifiers when it will emit ESM JavaScript.
  if (/\.[cm]?js$/.test(path))
    candidates.push(
      path
        .replace(/\.js$/, ".ts")
        .replace(/\.mjs$/, ".mts")
        .replace(/\.cjs$/, ".cts"),
    );
  for (const candidate of candidates) {
    const match = known.get(resolve(candidate));
    if (match) return match;
    try {
      const real = known.get(realpathSync(candidate));
      if (real) return real;
    } catch {
      /* A missing candidate is normal during resolution. */
    }
  }
  return undefined;
}
