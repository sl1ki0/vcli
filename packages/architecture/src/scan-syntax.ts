import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import ts from "typescript";
import { JS_SOURCE, SOURCE, MAX_SOURCE_BYTES } from "./scan-inventory.ts";
import { compare, hash } from "./utils.ts";

export const CACHE_VERSION = `3:${ts.version}`;

export interface ImportRecord {
  specifier: string;
  kind: "import" | "type-import" | "reexport";
  line: number;
  endLine: number;
}
export interface ParsedFile {
  hash: string;
  imports: ImportRecord[];
  signatures: string[];
  diagnostics: string[];
}
export interface IndexCache {
  version: string;
  root: string;
  files: Record<string, ParsedFile>;
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validCache(value: unknown, root: string): value is IndexCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as IndexCache;
  if (
    cache.version !== CACHE_VERSION ||
    cache.root !== root ||
    !cache.files ||
    typeof cache.files !== "object"
  )
    return false;
  return Object.values(cache.files).every(
    (record) =>
      record &&
      typeof record.hash === "string" &&
      Array.isArray(record.imports) &&
      Array.isArray(record.signatures) &&
      Array.isArray(record.diagnostics) &&
      record.signatures.every((s) => typeof s === "string") &&
      record.diagnostics.every((s) => typeof s === "string") &&
      record.imports.every(
        (i) =>
          i &&
          typeof i.specifier === "string" &&
          ["import", "type-import", "reexport"].includes(i.kind) &&
          Number.isInteger(i.line) &&
          Number.isInteger(i.endLine),
      ),
  );
}

export async function loadCache(root: string, diagnostics: string[]): Promise<IndexCache> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(root, ".vcli", "state", "architecture-index.json"), "utf8"),
    );
    if (validCache(value, root)) return value;
  } catch (error) {
    if (!isMissing(error))
      diagnostics.push("Architecture index could not be read; rebuilding it from source");
  }
  return { version: CACHE_VERSION, root, files: {} };
}

export async function persistCache(cache: IndexCache, diagnostics: string[]) {
  const directory = join(cache.root, ".vcli", "state");
  const temporary = join(directory, `.architecture-index-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, join(directory, "architecture-index.json"));
  } catch (error) {
    diagnostics.push(`Architecture index was not saved: ${(error as Error).message}`);
  }
}

function parseSource(path: string, text: string, contentHash: string): ParsedFile {
  if (!JS_SOURCE.test(path))
    return { hash: contentHash, imports: [], signatures: [], diagnostics: [] };
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports: ImportRecord[] = [];
  const signatures: string[] = [];
  function addImport(node: ts.Node, specifier: string, kind: ImportRecord["kind"]) {
    imports.push({
      specifier,
      kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          names &&
          ts.isNamedImports(names) &&
          names.elements.length > 0 &&
          names.elements.every((n) => n.isTypeOnly));
      addImport(node, node.moduleSpecifier.text, typeOnly ? "type-import" : "import");
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addImport(node, node.moduleSpecifier.text, node.isTypeOnly ? "type-import" : "reexport");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addImport(
        node,
        node.moduleReference.expression.text,
        node.isTypeOnly ? "type-import" : "import",
      );
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addImport(node, (node.arguments[0] as ts.StringLiteralLike).text, "import");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))
      signatures.push(statement.getText(source).slice(0, 240));
    else if (exported) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          signatures.push(
            `export ${statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${declaration.name.getText(source)}${declaration.type ? `: ${declaration.type.getText(source)}` : ""}`.slice(
              0,
              240,
            ),
          );
      } else if (ts.isFunctionDeclaration(statement))
        signatures.push(
          statement
            .getText(source)
            .slice(
              0,
              statement.body ? statement.body.getStart(source) - statement.getStart(source) : 240,
            )
            .trim()
            .slice(0, 240),
        );
      else if (
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      )
        signatures.push(statement.getText(source).split("{")[0]!.trim().slice(0, 240));
      else if (ts.isTypeAliasDeclaration(statement))
        signatures.push(statement.getText(source).slice(0, 240));
    }
  }
  const parseDiagnostics = (
    source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  const diagnostics = parseDiagnostics.map(
    (d) =>
      `${path}:${source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
  return {
    hash: contentHash,
    imports: imports.sort((a, b) => a.line - b.line || compare(a.specifier, b.specifier)),
    signatures: [...new Set(signatures)],
    diagnostics,
  };
}

export interface SyntaxIndex {
  files: Map<string, ParsedFile>;
  lineCounts: Map<string, number>;
  cache: IndexCache;
  parsed: number;
  cached: number;
}

/** Hash every source, but reuse syntax facts until its content changes. */
export async function collectSyntaxFacts(
  root: string,
  paths: string[],
  previousCache: IndexCache,
  diagnostics: string[],
): Promise<SyntaxIndex> {
  const index: SyntaxIndex = {
    files: new Map(),
    lineCounts: new Map(),
    cache: { version: CACHE_VERSION, root, files: {} },
    parsed: 0,
    cached: 0,
  };
  for (const path of paths.filter((path) => SOURCE.test(path))) {
    try {
      const absolute = join(root, path);
      if ((await stat(absolute)).size > MAX_SOURCE_BYTES) {
        diagnostics.push(`${path}: source exceeds ${MAX_SOURCE_BYTES} bytes and was skipped`);
        continue;
      }
      const text = await readFile(absolute, "utf8");
      const contentHash = hash(text);
      const previous = previousCache.files[path];
      let record: ParsedFile;
      if (previous?.hash === contentHash) {
        record = previous;
        index.cached++;
      } else {
        record = parseSource(path, text, contentHash);
        index.parsed++;
      }
      index.cache.files[path] = record;
      index.files.set(path, record);
      index.lineCounts.set(path, text.split(/\r?\n/).length);
      diagnostics.push(...record.diagnostics);
    } catch (error) {
      diagnostics.push(`${path}: ${(error as Error).message}`);
    }
  }
  return index;
}
