import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { createArchitectureService } from "@vcli/architecture";

const root = resolve(import.meta.dir, "..");

test("declared package dependency boundaries have no source drift", async () => {
  const architecture = createArchitectureService();
  const graph = await architecture.scan(root);
  const design = await architecture.readDesign(root);
  expect(architecture.check(graph, design)).toEqual([]);
});

test("the core stays independent of terminal, SDK and Bun runtime imports", async () => {
  const imports: string[] = [];
  for await (const path of new Bun.Glob("packages/core/src/**/*.ts").scan({ cwd: root })) {
    const text = await readFile(resolve(root, path), "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(text).not.toMatch(/\bBun\./);
  }
  expect(imports.filter((name) => !name.startsWith(".") && name !== "ajv")).toEqual([]);
});
