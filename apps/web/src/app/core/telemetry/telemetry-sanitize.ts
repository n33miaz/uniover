/**
 * Higiene da telemetria de erros do cliente. Nada que chega ao servidor passa por aqui sem virar uma de poucas formas fixas:
 * a rota vira um MODELO de rota da lista permitida (`telemetry-routes.ts`), sem query, fragmento nem identificador; o código é um nome curto (nunca a mensagem do erro); o rastro do servidor
 * só entra se tiver o formato de um identificador. Texto livre, pilha de erro, endereço com dado da pessoa e o que ela digitou
 * nunca saem do aparelho. O que o servidor aceita é conferido de novo lá (mesmos limites).
 */

import { API_ROUTES, PAGE_ROUTES } from './telemetry-routes';

export const ROUTE_MAX = 120;
export const CODE_MAX = 48;
export const VERSION_MAX = 40;

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$/;
const TRACE = /^[A-Za-z0-9-]{8,64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;

/** O marcador fixo de um trecho de caminho que nenhum modelo da lista conhece. */
export const UNKNOWN_SEGMENT = ':x';
/** O marcador fixo de um parâmetro (o modelo diz que ali há um identificador). */
export const PARAM_SEGMENT = ':id';

interface RouteNode {
  readonly literals: Map<string, RouteNode>;
  param: RouteNode | null;
}

function buildTrie(templates: readonly string[]): RouteNode {
  const root: RouteNode = { literals: new Map(), param: null };
  for (const template of templates) {
    let node = root;
    for (const segment of template.split('/').filter((part) => part.length > 0)) {
      if (segment === PARAM_SEGMENT) {
        node.param ??= { literals: new Map(), param: null };
        node = node.param;
      } else {
        let next = node.literals.get(segment);
        if (!next) {
          next = { literals: new Map(), param: null };
          node.literals.set(segment, next);
        }
        node = next;
      }
    }
  }
  return root;
}

const PAGE_TRIE = buildTrie(PAGE_ROUTES);
const API_TRIE = buildTrie(API_ROUTES);

/** Só o caminho: sem endereço absoluto, query nem fragmento. */
function pathOf(input: string | null | undefined): string[] {
  if (!input) return [];
  let path = input;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (scheme) path = path.slice(scheme[0].length);
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Caminha pela lista de modelos: trecho que é literal do modelo fica como está; onde o modelo tem parâmetro o trecho vira
 * `:id` (seja qual for o valor); trecho que o modelo não conhece vira `:x` e o resto do caminho é descartado. O resultado
 * só pode ser um modelo da lista, ou um prefixo dele seguido de `:x`.
 */
function toTemplate(segments: readonly string[], trie: RouteNode): string {
  const out: string[] = [];
  let node = trie;
  for (const segment of segments) {
    const literal = node.literals.get(segment);
    if (literal) {
      out.push(segment);
      node = literal;
    } else if (node.param) {
      out.push(PARAM_SEGMENT);
      node = node.param;
    } else {
      out.push(UNKNOWN_SEGMENT);
      break;
    }
  }
  const joined = `/${out.join('/')}`;
  return joined.length > ROUTE_MAX ? joined.slice(0, ROUTE_MAX) : joined;
}

/** A rota da tela como modelo da lista permitida (`/treino/rotinas/:id`); o que a lista não conhece vira `:x`. */
export function normalizeRoute(input: string | null | undefined): string {
  return toTemplate(pathOf(input), PAGE_TRIE);
}

/** O caminho da API como modelo da lista permitida (`/api/v1/tv/shortcuts/:id/launch`); o que a lista não conhece vira `:x`. */
export function normalizeApiPath(input: string | null | undefined): string {
  return toTemplate(pathOf(input), API_TRIE);
}

/** Um código curto no alfabeto seguro, ou `null`. Serve para o nome do erro (`TypeError`) e para códigos próprios (`http_503`). */
export function safeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

/** O `X-Trace-Id` da resposta, se tiver o formato de um identificador; senão `null`. */
export function safeTrace(value: unknown): string | null {
  return typeof value === 'string' && TRACE.test(value) ? value : null;
}

/** A versão do app, se for uma versão; senão `null`. */
export function safeVersion(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

/**
 * O nome de um valor lançado (`TypeError`, `HttpErrorResponse`...). Só o nome da classe: a mensagem e a pilha podem
 * carregar texto da pessoa, endereço com dado, trecho de resposta. Qualquer outra coisa vira `unknown`.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return safeCode(error.name) ?? 'Error';
  return 'unknown';
}
