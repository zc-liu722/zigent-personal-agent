import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { definitions, trackedFiles, inputOwner } from './catalogue.mjs';

/** Build-time contract checks, including imports erased by TypeScript. */
export async function validateBoundaries(source) {
  const providers = new Map(), dependencies = new Map();
  for (const [id, definition] of Object.entries(definitions)) {
    for (const name of Object.keys(definition.provides)) {
      if (providers.has(name)) throw Error(`PLUGIN_DUPLICATE_SERVICE ${name}`);
      providers.set(name, id);
    }
  }
  for (const [id, definition] of Object.entries(definitions)) {
    dependencies.set(id, Object.entries(definition.requires).map(([name, range]) => {
      const provider = providers.get(name), version = definitions[provider]?.provides[name];
      if (!provider || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max
        || version < range.min || version > range.max) throw Error(`PLUGIN_DEPENDENCY_INCOMPATIBLE ${id}:${name}`);
      return provider;
    }));
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Error(`PLUGIN_DEPENDENCY_CYCLE ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id)) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of dependencies.keys()) visit(id);
  for (const file of trackedFiles(source).filter(file => definitions[inputOwner(file)] && /\.[cm]?tsx?$/.test(file))) {
    const tree = ts.createSourceFile(file, await readFile(resolve(source, file), 'utf8'), ts.ScriptTarget.Latest, true);
    function check(node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require') ? node.arguments[0]
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = relative(source, resolve(source, dirname(file), specifier.text)).replaceAll('\\', '/');
        const owner = inputOwner(target);
        if (definitions[owner] && owner !== inputOwner(file)) throw Error(`PLUGIN_PRIVATE_IMPORT ${file} -> ${target}`);
      }
      ts.forEachChild(node, check);
    }
    check(tree);
  }
}
