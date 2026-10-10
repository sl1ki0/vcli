import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@vcli/core";
import { findCycles, graphRevision } from "./graph.ts";
import { compare, hash, matchesPath, slash } from "./utils.ts";

const CACHE_VERSION = `3:${ts.version}`;
const ALWAYS_IGNORED = new Set([".git", "node_modules", ".vcli", "dist", ".cache", ".next", ".turbo", "coverage", "target", "vendor", "__pycache__", ".venv", "venv"]);
const JS_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx|py|rs|go|java|kt|kts|cs|c|cc|cpp|h|hpp|rb|php|swift|sh|bash|zsh|vue|svelte)$/i;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

interface ImportRecord { specifier: string; kind: "import" | "type-import" | "reexport"; line: number; endLine: number }
interface ParsedFile { hash: string; imports: ImportRecord[]; signatures: string[]; diagnostics: string[] }
interface IndexCache { version: string; root: string; files: Record<string, ParsedFile> }
interface Manifest { path: string; directory: string; value: Record<string, unknown>; text: string }
interface IgnoreRule { base: string; pattern: string; negate: boolean }

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

async function inventory(root: string, diagnostics: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string, inherited: IgnoreRule[]) {
    let rules = inherited;
    try {
      const text = await readFile(join(directory, ".gitignore"), "utf8");
      const base = slash(relative(root, directory));
      rules = [...rules, ...text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => ({ base, pattern: line.replace(/^!/, "").replace(/^\//, "").replace(/\/$/, ""), negate: line.startsWith("!") }))];
    } catch (error) { if (!isMissing(error)) diagnostics.push(`Could not read ${slash(relative(root, directory)) || "."}/.gitignore: ${(error as Error).message}`); }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ALWAYS_IGNORED.has(entry.name)) continue;
      const absolute = join(directory, entry.name), path = slash(relative(root, absolute));
      let ignored = false;
      for (const rule of rules) {
        const local = rule.base ? path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : undefined : path;
        if (local === undefined) continue;
        const matched = rule.pattern.includes("/") ? matchesPath(local, rule.pattern) : local.split("/").some(part => matchesPath(part, rule.pattern));
        if (matched) ignored = !rule.negate;
      }
      if (ignored) continue;
      if (entry.isDirectory()) await walk(absolute, rules);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root, []);
  return files.sort(compare);
}

function validCache(value: unknown, root: string): value is IndexCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as IndexCache;
  if (cache.version !== CACHE_VERSION || cache.root !== root || !cache.files || typeof cache.files !== "object") return false;
  return Object.values(cache.files).every(record => record && typeof record.hash === "string" && Array.isArray(record.imports) && Array.isArray(record.signatures) && Array.isArray(record.diagnostics)
    && record.signatures.every(s => typeof s === "string") && record.diagnostics.every(s => typeof s === "string")
    && record.imports.every(i => i && typeof i.specifier === "string" && ["import", "type-import", "reexport"].includes(i.kind) && Number.isInteger(i.line) && Number.isInteger(i.endLine)));
}

async function loadCache(root: string, diagnostics: string[]): Promise<IndexCache> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, ".vcli", "state", "architecture-index.json"), "utf8"));
    if (validCache(value, root)) return value;
  } catch (error) {
    if (!isMissing(error)) diagnostics.push("Architecture index could not be read; rebuilding it from source");
  }
  return { version: CACHE_VERSION, root, files: {} };
}

async function persistCache(cache: IndexCache, diagnostics: string[]) {
  const directory = join(cache.root, ".vcli", "state");
  const temporary = join(directory, `.architecture-index-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, join(directory, "architecture-index.json"));
  } catch (error) { diagnostics.push(`Architecture index was not saved: ${(error as Error).message}`); }
}

function parseSource(path: string, text: string, contentHash: string): ParsedFile {
  if (!JS_SOURCE.test(path)) return { hash: contentHash, imports: [], signatures: [], diagnostics: [] };
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports: ImportRecord[] = [];
  const signatures: string[] = [];
  function addImport(node: ts.Node, specifier: string, kind: ImportRecord["kind"]) {
    imports.push({ specifier, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names) && names.elements.length > 0 && names.elements.every(n => n.isTypeOnly));
      addImport(node, node.moduleSpecifier.text, typeOnly ? "type-import" : "import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addImport(node, node.moduleSpecifier.text, node.isTypeOnly ? "type-import" : "reexport");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      addImport(node, node.moduleReference.expression.text, node.isTypeOnly ? "type-import" : "import");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      addImport(node, (node.arguments[0] as ts.StringLiteralLike).text, "import");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) signatures.push(statement.getText(source).slice(0, 240));
    else if (exported) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) signatures.push(`export ${statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${declaration.name.getText(source)}${declaration.type ? `: ${declaration.type.getText(source)}` : ""}`.slice(0, 240));
      } else if (ts.isFunctionDeclaration(statement)) signatures.push(statement.getText(source).slice(0, statement.body ? statement.body.getStart(source) - statement.getStart(source) : 240).trim().slice(0, 240));
      else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) signatures.push(statement.getText(source).split("{")[0]!.trim().slice(0, 240));
      else if (ts.isTypeAliasDeclaration(statement)) signatures.push(statement.getText(source).slice(0, 240));
    }
  }
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  const diagnostics = parseDiagnostics.map(d => `${path}:${source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  return { hash: contentHash, imports: imports.sort((a, b) => a.line - b.line || compare(a.specifier, b.specifier)), signatures: [...new Set(signatures)], diagnostics };
}

function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const condition of ["types", "import", "require", "default"]) {
      const target = exportTarget(object[condition]); if (target) return target;
    }
  }
  return undefined;
}

function workspaceEntry(manifest: Manifest, specifier: string): string | undefined {
  const name = manifest.value.name as string;
  const subpath = specifier.slice(name.length).replace(/^\//, "");
  const exports = manifest.value.exports;
  if (exports !== undefined) {
    if (typeof exports === "object" && exports !== null && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith("."))) {
      const entries = exports as Record<string, unknown>;
      const key = subpath ? `./${subpath}` : ".";
      const exact = exportTarget(entries[key]); if (exact) return join(manifest.directory, exact);
      for (const pattern of Object.keys(entries).sort(compare)) {
        if (!pattern.includes("*")) continue;
        const [start, end] = pattern.split("*");
        if (key.startsWith(start!) && key.endsWith(end!)) {
          const target = exportTarget(entries[pattern]);
          if (target) return join(manifest.directory, target.replaceAll("*", key.slice(start!.length, key.length - end!.length)));
        }
      }
      return undefined;
    }
    return subpath ? undefined : exportTarget(exports) ? join(manifest.directory, exportTarget(exports)!) : undefined;
  }
  if (subpath) return join(manifest.directory, subpath);
  for (const field of ["source", "types", "module", "main"]) {
    if (typeof manifest.value[field] === "string") return join(manifest.directory, manifest.value[field] as string);
  }
  return join(manifest.directory, "index");
}

function fileCandidate(path: string, known: Map<string, ArchitectureNode>): ArchitectureNode | undefined {
  const candidates = [path, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"].map(e => `${path}${e}`), ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.d.ts"].map(e => join(path, e))];
  // TypeScript source uses .js specifiers when it will emit ESM JavaScript.
  if (/\.[cm]?js$/.test(path)) candidates.push(path.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts"));
  for (const candidate of candidates) {
    const match = known.get(resolve(candidate)); if (match) return match;
    try { const real = known.get(realpathSync(candidate)); if (real) return real; } catch { /* A missing candidate is normal during resolution. */ }
  }
  return undefined;
}

export async function scan(rootPath: string): Promise<ArchitectureGraph> {
  const started = performance.now();
  const root = resolve(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error(`Architecture root is not a directory: ${root}`);
  const diagnostics: string[] = [];
  const paths = await inventory(root, diagnostics);
  const inventoried = new Set(paths);
  const cache = await loadCache(root, diagnostics);
  const nextCache: IndexCache = { version: CACHE_VERSION, root, files: {} };
  const manifests: Manifest[] = [];
  for (const path of paths.filter(p => basename(p) === "package.json")) {
    try {
      const text = await readFile(join(root, path), "utf8"), value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
      manifests.push({ path, directory: dirname(join(root, path)), value: value as Record<string, unknown>, text });
    } catch (error) { diagnostics.push(`${path}: ${(error as Error).message}`); }
  }
  const packageNodes: ArchitectureNode[] = manifests.map(m => ({ id: `package:${slash(relative(root, m.directory)) || "."}`, label: typeof m.value.name === "string" ? m.value.name : basename(m.directory), kind: "package", path: slash(relative(root, m.directory)) || ".", status: "observed", evidence: [{ path: m.path, line: 1 }] }));
  function owner(path: string): ArchitectureNode | undefined {
    return packageNodes.filter(n => n.path === "." || path.startsWith(`${n.path}/`)).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
  }
  for (const n of packageNodes) if (n.path !== ".") n.parent = owner(dirname(n.path!))?.id;
  const nodes: ArchitectureNode[] = [...packageNodes];
  const edges: ArchitectureEdge[] = packageNodes.filter(n => n.parent).map(n => ({ id: `contains:${n.parent}->${n.id}`, source: n.parent!, target: n.id, kind: "contains", status: "observed" }));
  const parsed = new Map<string, ParsedFile>();
  const known = new Map<string, ArchitectureNode>();
  let parsedCount = 0, cachedCount = 0;
  for (const path of paths.filter(p => SOURCE.test(p))) {
    try {
      const absolute = join(root, path);
      if ((await stat(absolute)).size > MAX_SOURCE_BYTES) { diagnostics.push(`${path}: source exceeds ${MAX_SOURCE_BYTES} bytes and was skipped`); continue; }
      const text = await readFile(absolute, "utf8"), contentHash = hash(text);
      const previous = cache.files[path];
      let record: ParsedFile;
      if (previous?.hash === contentHash) { record = previous; cachedCount++; }
      else { record = parseSource(path, text, contentHash); parsedCount++; }
      nextCache.files[path] = record; parsed.set(path, record); diagnostics.push(...record.diagnostics);
      const node: ArchitectureNode = { id: `${JS_SOURCE.test(path) ? "module" : "file"}:${path}`, label: path, kind: JS_SOURCE.test(path) ? "module" : "file", path, parent: owner(path)?.id, signatures: record.signatures, evidence: [{ path, line: 1, endLine: text.split(/\r?\n/).length }], status: "observed" };
      nodes.push(node); known.set(absolute, node);
      try { known.set(realpathSync(absolute), node); } catch { /* Removed during indexing; resolution will diagnose missing dependencies. */ }
      if (node.parent) edges.push({ id: `contains:${node.parent}->${node.id}`, source: node.parent, target: node.id, kind: "contains", status: "observed" });
    } catch (error) { diagnostics.push(`${path}: ${(error as Error).message}`); }
  }
  const workspace = new Map<string, Manifest>();
  for (const manifest of manifests) {
    if (typeof manifest.value.name !== "string") continue;
    if (workspace.has(manifest.value.name)) diagnostics.push(`Duplicate workspace package name: ${manifest.value.name}`);
    else workspace.set(manifest.value.name, manifest);
  }
  const optionsCache = new Map<string, ts.CompilerOptions>();
  const resolutionCaches = new Map<string, ts.ModuleResolutionCache>();
  function optionsFor(file: string): { key: string; options: ts.CompilerOptions } {
    let directory = dirname(file), config: string | undefined;
    while (directory === root || (!relative(root, directory).startsWith("..") && !isAbsolute(relative(root, directory)))) {
      const candidate = join(directory, "tsconfig.json");
      if (existsSync(candidate)) { config = candidate; break; }
      if (directory === root) break;
      directory = dirname(directory);
    }
    const key = config ?? root;
    if (!optionsCache.has(key)) {
      let options: ts.CompilerOptions = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, resolveJsonModule: true };
      if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error) diagnostics.push(`${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
        else {
          const content = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
          options = { ...options, ...content.options };
          for (const error of content.errors.filter(e => e.code !== 18003)) diagnostics.push(`${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
        }
      }
      optionsCache.set(key, options); resolutionCaches.set(key, ts.createModuleResolutionCache(root, name => name, options));
    }
    return { key, options: optionsCache.get(key)! };
  }
  const external = new Map<string, ArchitectureNode>();
  for (const [path, record] of parsed) {
    const source = known.get(join(root, path))!;
    if (!record.imports.length) continue;
    const { key, options } = optionsFor(join(root, path));
    for (const reference of record.imports) {
      const resolved = ts.resolveModuleName(reference.specifier, join(root, path), options, ts.sys, resolutionCaches.get(key)).resolvedModule;
      let target = resolved ? fileCandidate(resolved.resolvedFileName, known) : undefined;
      if (!target && reference.specifier.startsWith(".")) target = fileCandidate(resolve(dirname(join(root, path)), reference.specifier), known);
      const name = packageName(reference.specifier), local = workspace.get(name);
      if (!target && local) {
        const entry = workspaceEntry(local, reference.specifier);
        if (entry) target = fileCandidate(entry, known);
      }
      if (!target) {
        const candidates = [resolved?.resolvedFileName, reference.specifier.startsWith(".") ? resolve(dirname(join(root, path)), reference.specifier) : undefined];
        for (const absolute of candidates) {
          if (!absolute) continue;
          const assetPath = slash(relative(root, absolute));
          if (!inventoried.has(assetPath)) continue;
          target = known.get(absolute);
          if (!target) {
            target = { id: `file:${assetPath}`, label: assetPath, path: assetPath, kind: "file", parent: owner(assetPath)?.id, status: "observed" };
            known.set(absolute, target); nodes.push(target);
            if (target.parent) edges.push({ id: `contains:${target.parent}->${target.id}`, source: target.parent, target: target.id, kind: "contains", status: "observed" });
          }
          break;
        }
      }
      if (!target) {
        const relativeReference = reference.specifier.startsWith(".") || isAbsolute(reference.specifier);
        const manifest = manifests.find(m => `package:${slash(relative(root, m.directory)) || "."}` === source.parent);
        const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(field => manifest?.value[field] && typeof manifest.value[field] === "object" && Object.hasOwn(manifest.value[field] as object, name));
        const unresolved = relativeReference || !!local || (!resolved && !declared && !builtins.has(reference.specifier));
        const id = unresolved && relativeReference ? `unresolved:${path}:${reference.specifier}` : `${unresolved ? "unresolved" : "external"}:${name}`;
        target = external.get(id);
        if (!target) { target = { id, label: relativeReference ? reference.specifier : name, kind: "external", status: unresolved ? "unresolved" : "observed" }; external.set(id, target); nodes.push(target); }
        if (unresolved) diagnostics.push(`Unresolved import ${JSON.stringify(reference.specifier)} in ${path}:${reference.line}`);
      }
      edges.push({ id: `${reference.kind}:${source.id}->${target.id}:${reference.line}`, source: source.id, target: target.id, kind: reference.kind, status: target.status === "unresolved" ? "unresolved" : "observed", evidence: [{ path, line: reference.line, endLine: reference.endLine }] });
    }
  }
  nodes.sort((a, b) => compare(a.id, b.id)); edges.sort((a, b) => compare(a.id, b.id));
  if (JSON.stringify(cache) !== JSON.stringify(nextCache)) await persistCache(nextCache, diagnostics);
  const salt = JSON.stringify({ files: Object.entries(nextCache.files).map(([path, record]) => [path, record.hash]), manifests: manifests.map(m => [m.path, hash(m.text)]), options: [...optionsCache.entries()] });
  return {
    root, revision: graphRevision(nodes, edges, salt), nodes, edges, diagnostics: [...new Set(diagnostics)].sort(compare), cycles: findCycles(nodes, edges),
    stats: { files: parsed.size, parsed: parsedCount, cached: cachedCount, durationMs: Math.round((performance.now() - started) * 100) / 100 },
  };
}
