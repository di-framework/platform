import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

/** Add Node ESM extensions to emitted files while keeping source imports extensionless. */
export function fixEsmImports(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      fixEsmImports(file);
      continue;
    }
    if (!entry.isFile() || !(file.endsWith('.js') || file.endsWith('.d.ts'))) continue;
    const source = readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const edits: { start: number; end: number; value: string }[] = [];
    function visit(node: ts.Node): void {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        specifier = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
      }
      if (specifier && ts.isStringLiteral(specifier) && /^\.{1,2}\//.test(specifier.text)) {
        const target = resolve(dirname(file), specifier.text);
        const suffix = existsSync(`${target}.js`)
          ? '.js'
          : existsSync(join(target, 'index.js'))
            ? '/index.js'
            : undefined;
        if (suffix) {
          edits.push({
            start: specifier.getStart(parsed) + 1,
            end: specifier.getEnd() - 1,
            value: specifier.text + suffix,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    let result = source;
    for (const edit of edits.reverse()) {
      result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    }
    if (result !== source) writeFileSync(file, result);
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      'Usage: bun packages/di-framework-cli/scripts/fix-esm-imports.ts <output-directory>',
    );
  fixEsmImports(resolve(directory));
}
