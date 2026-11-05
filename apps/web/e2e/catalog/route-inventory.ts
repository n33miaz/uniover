import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * Lê os arquivos de rotas do app (a casca e cada módulo) e devolve todo endereço que abre uma tela ou que redireciona. É o
 * que mantém o catálogo honesto: uma rota nova que ninguém pôs no catálogo aparece como "sem captura" no quadro de cobertura.
 */

const APP = join('src', 'app');

/** Cada arquivo de rotas e o prefixo onde ele é montado (o `loadChildren` do pai). */
const FILES: readonly { file: string; prefix: string }[] = [
  { file: join(APP, 'app.routes.ts'), prefix: '' },
  { file: join(APP, 'modules', 'home', 'home.routes.ts'), prefix: '' },
  { file: join(APP, 'modules', 'tv', 'tv.routes.ts'), prefix: '/tv' },
  { file: join(APP, 'modules', 'training', 'training.routes.ts'), prefix: '/treino' },
  { file: join(APP, 'modules', 'pc', 'pc.routes.ts'), prefix: '/pc' },
  { file: join(APP, 'settings.routes.ts'), prefix: '/ajustes' },
];

export interface InventoryRoute {
  /** O endereço completo, com `:parâmetros`. */
  path: string;
  kind: 'screen' | 'redirect';
  source: string;
}

function propName(property: ts.ObjectLiteralElementLike): string | null {
  return ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
    ? property.name.text
    : null;
}

function stringProp(object: ts.ObjectLiteralExpression, name: string): string | null {
  for (const property of object.properties) {
    if (propName(property) === name && ts.isPropertyAssignment(property)) {
      const value = property.initializer;
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    }
  }
  return null;
}

function has(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((property) => propName(property) === name);
}

function join2(prefix: string, path: string): string {
  const joined = [prefix, path].filter((part) => part !== '').join('/');
  return (joined.startsWith('/') ? joined : `/${joined}`).replace(/\/+/g, '/');
}

function walk(
  array: ts.ArrayLiteralExpression,
  prefix: string,
  source: string,
  out: InventoryRoute[],
): void {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const path = stringProp(element, 'path');
    if (path === null) continue;
    const full = path === '**' ? '/**' : join2(prefix, path);
    const children = element.properties.find((p) => propName(p) === 'children');

    if (has(element, 'redirectTo')) {
      out.push({ path: full, kind: 'redirect', source });
      continue;
    }
    // O `loadChildren` só monta o arquivo de rotas de um módulo: a tela está lá, não aqui.
    if (has(element, 'loadChildren')) continue;
    // Uma casca com `component` (o Pc, o escopo do Treino) só abriga os filhos; a tela dela é o filho de caminho vazio.
    const isShell = has(element, 'component') && children !== undefined;
    if (!isShell && (has(element, 'loadComponent') || has(element, 'component'))) {
      out.push({ path: full, kind: 'screen', source });
    }
    if (
      children &&
      ts.isPropertyAssignment(children) &&
      ts.isArrayLiteralExpression(children.initializer)
    ) {
      walk(children.initializer, full, source, out);
    }
  }
}

/** Todas as telas e redirecionamentos do app, sem repetição. */
export function inventoryRoutes(): InventoryRoute[] {
  const out: InventoryRoute[] = [];
  for (const { file, prefix } of FILES) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      // Só a lista de rotas do topo do arquivo (`export const X: Routes = [...]`).
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer) &&
        node.type &&
        ts.isTypeReferenceNode(node.type) &&
        node.type.typeName.getText(sourceFile) === 'Routes'
      ) {
        walk(node.initializer, prefix, file, out);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const seen = new Set<string>();
  return out.filter((route) => {
    const key = `${route.kind}:${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
