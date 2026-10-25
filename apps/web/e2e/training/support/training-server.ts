import { BrowserContext, Route } from '@playwright/test';
import { OWNER_ID } from '../../auth/identity-mock';

/**
 * Servidor de teste do Treino: simula a API (`/api/v1/training/**`) com rotas do Playwright e implementa as convenções do
 * módulo para QUALQUER recurso, sem saber o que cada um guarda:
 *
 * - escrita é `PUT /<recurso>/<id>`, idempotente: a mesma `Idempotency-Key` devolve a resposta guardada (com
 *   `Idempotent-Replayed`) e não executa de novo;
 * - conflito é "o último a escrever": o `clientUpdatedAt` mais velho que o guardado devolve 200 com o registro guardado,
 *   sem mudar nada; mais de 24 h no futuro é 422 `client-clock-ahead`;
 * - apagar é lápide (`deleted: true` no corpo), nunca `DELETE`;
 * - leitura é `GET /<recurso>?after=&limit=`, por cursor (base64url de `<ticks .NET>|<uuid>`), ordenada por
 *   (`updatedAt`, `id`) e com as lápides;
 * - falhas e atrasos programáveis, e um interruptor de "sem rede" (a requisição é abortada como se a rede tivesse caído).
 *
 * Os dados-semente entram por `seed`. As telas irmãs reutilizam este arquivo: recurso novo não pede código novo.
 *
 * Os dados são POR CONTA, como na API (`UserId` em toda consulta): a conta é o `sub` do token do pedido (o simulador de
 * identidade o emite igual ao id do `/me`). Pedido sem token vale como o dono, então os testes de uma conta só não mudam; e
 * cada `Hit` registra de quem era o token, para um teste provar que nada saiu com o token de outra conta.
 *
 * Use junto de `serviceWorkers: 'block'`: o Playwright não intercepta o que passa pelo service worker.
 */

export type Row = Record<string, unknown> & { id: string };

export interface Hit {
  readonly method: string;
  /** O caminho depois de `/api/v1/training/`, sem a consulta. */
  readonly path: string;
  readonly key: string;
  /** A conta a quem o token do pedido pertence (o `sub`); sem token, a do dono. */
  readonly account: string;
  /** `executed` · `replayed` · `stale` (o guardado era mais novo) · `rejected` (falha programada ou 422) · `down`. */
  readonly outcome: string;
}

export interface FailureRule {
  readonly method?: string;
  /** Casa com o caminho depois de `/api/v1/training/`. */
  readonly path: RegExp;
  readonly status: number;
  /** Final do `type` do ProblemDetails (`client-clock-ahead`). */
  readonly problem?: string;
  /** Quantas vezes falha antes de voltar ao normal; padrão 1. */
  readonly times?: number;
}

export interface TrainingServer {
  /** Derruba toda chamada como se não houvesse rede. */
  offline: boolean;
  /** Espera antes de responder (ms). */
  delayMs: number;
  readonly hits: Hit[];
  /** Os modelos de rotina que `GET /routine-templates` devolve. */
  templates: unknown;
  /** Programa uma falha para as próximas requisições que casarem. */
  failNext(rule: FailureRule): void;
  /** Põe linhas numa coleção de uma conta (como se já estivessem no servidor); sem conta, a do dono. */
  seed(collection: string, rows: readonly Record<string, unknown>[], account?: string): void;
  /** As linhas de uma coleção de uma conta, com lápides; sem conta, a do dono. */
  rows(collection: string, account?: string): Row[];
  /** Quantas vezes o `PUT` com esta chave executou de verdade. */
  executions(key: string): number;
  /** Quantas escritas executaram de verdade numa coleção de uma conta (`PUT`s que mudaram algo ou criaram); sem conta, a do dono. */
  writes(collection: string, account?: string): number;
}

const BASE = '/api/v1/training/';
/** Quem chama quando o pedido vem sem token (a sessão ainda por confirmar): o dono, como nos testes de uma conta só. */
const DEFAULT_ACCOUNT = OWNER_ID;
const PROBLEM_BASE = 'https://uniover.app/problems/';
const DAY_MS = 24 * 60 * 60 * 1000;
// .NET conta tempo em ticks de 100 ns desde 0001-01-01; a diferença até a época Unix, em ms:
const UNIX_EPOCH_MS_IN_DOTNET = 62_135_596_800_000n;

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  });

const problem = (route: Route, status: number, kind: string) =>
  route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title: kind, status }),
  });

/** A conta do token do pedido: o `sub` do JWT; sem token legível, o dono. */
function accountOf(headers: Record<string, string>): string {
  const token = headers['authorization']?.replace(/^Bearer /, '');
  try {
    const payload = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString()) as {
      sub?: unknown;
    };
    return typeof payload.sub === 'string' ? payload.sub : DEFAULT_ACCOUNT;
  } catch {
    return DEFAULT_ACCOUNT;
  }
}

/** Instante em milissegundos como a API o escreve (.NET, sete casas de fração). */
export function dotnetInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$10000+00:00');
}

function encodeCursor(updatedMs: number, id: string): string {
  const ticks = (BigInt(updatedMs) + UNIX_EPOCH_MS_IN_DOTNET) * 10_000n;
  return Buffer.from(`${ticks}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { ms: number; id: string } | null {
  try {
    const [ticks, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    if (!/^\d+$/.test(ticks) || !id) return null;
    return { ms: Number(BigInt(ticks) / 10_000n - UNIX_EPOCH_MS_IN_DOTNET), id };
  } catch {
    return null;
  }
}

/** O que o servidor acrescenta a um registro novo, por coleção (campos que o corpo do `PUT` não traz). */
const NEW_ROW_DEFAULTS: Record<string, (id: string, body: Record<string, unknown>) => Row> = {
  exercises: (id, body) => ({
    id,
    slug: `${String(body['name'] ?? 'exercicio')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-${id.slice(-8)}`,
    source: 'own',
    sourceRef: null,
    level: null,
    category: null,
    mechanic: null,
    license: null,
    licenseAuthor: null,
    licenseUrl: null,
    reviewed: true,
    stepKg: null,
    stepClientUpdatedAt: null,
  }),
  // O alimento que a pessoa cadastra volta do servidor como "próprio" e sem atribuição (a resposta sempre traz os dois).
  foods: () => ({ source: 'own', attribution: null }),
};

interface Stored {
  readonly status: number;
  readonly body: string;
}

export async function mockTrainingApi(context: BrowserContext): Promise<TrainingServer> {
  // Por conta e depois por coleção, como o servidor guarda por `UserId`.
  const collections = new Map<string, Map<string, Row>>();
  const replies = new Map<string, Stored>();
  const executions = new Map<string, number>();
  const writes = new Map<string, number>();
  const rules: { rule: FailureRule; left: number }[] = [];
  let lastUpdated = 0;

  const collection = (account: string, name: string): Map<string, Row> => {
    const key = `${account}/${name}`;
    let found = collections.get(key);
    if (!found) {
      found = new Map();
      collections.set(key, found);
    }
    return found;
  };

  /** O relógio do servidor: nunca repete nem recua, para o cursor ordenar sem empate. */
  const tick = (): number => {
    lastUpdated = Math.max(Date.now(), lastUpdated + 1);
    return lastUpdated;
  };

  const server: TrainingServer = {
    offline: false,
    delayMs: 0,
    hits: [],
    templates: { items: [] },
    failNext: (rule) => void rules.push({ rule, left: rule.times ?? 1 }),
    seed: (name, rows, account = DEFAULT_ACCOUNT) => {
      for (const row of rows) {
        const stamped: Row = {
          updatedAt: dotnetInstant(tick()),
          clientUpdatedAt: dotnetInstant(Date.now() - DAY_MS),
          deleted: false,
          ...row,
        } as Row;
        collection(account, name).set(stamped.id, stamped);
      }
    },
    rows: (name, account = DEFAULT_ACCOUNT) => [...collection(account, name).values()],
    executions: (key) => executions.get(key) ?? 0,
    writes: (name, account = DEFAULT_ACCOUNT) => writes.get(`${account}/${name}`) ?? 0,
  };

  await context.route(`**${BASE}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(url.pathname.indexOf(BASE) + BASE.length);
    const method = request.method();
    const key = request.headers()['idempotency-key'] ?? '';
    const account = accountOf(request.headers());
    const hit = (outcome: string) => server.hits.push({ method, path, key, account, outcome });

    if (server.offline) {
      hit('down');
      return route.abort('internetdisconnected');
    }
    if (server.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.delayMs));

    const failing = rules.find(
      (item) =>
        item.left > 0 &&
        (!item.rule.method || item.rule.method === method) &&
        item.rule.path.test(path),
    );
    if (failing) {
      failing.left--;
      hit('rejected');
      return failing.rule.problem
        ? problem(route, failing.rule.status, failing.rule.problem)
        : route.fulfill({ status: failing.rule.status, body: '' });
    }

    if (method === 'GET' && path === 'routine-templates') {
      hit('read');
      return json(route, 200, server.templates);
    }

    if (method === 'GET') {
      const name = path.split('/')[0];
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
      const after = decodeCursor(url.searchParams.get('after') ?? '');
      const ordered = [...collection(account, name).values()].sort((a, b) => {
        const left = Date.parse(String(a['updatedAt']).replace(/(\.\d{3})\d+/, '$1'));
        const right = Date.parse(String(b['updatedAt']).replace(/(\.\d{3})\d+/, '$1'));
        return left - right || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const fresh = after
        ? ordered.filter((row) => {
            const at = Date.parse(String(row['updatedAt']).replace(/(\.\d{3})\d+/, '$1'));
            return at > after.ms || (at === after.ms && row.id > after.id);
          })
        : ordered;
      const items = fresh.slice(0, limit);
      const last = items[items.length - 1];
      hit('read');
      return json(route, 200, {
        items,
        nextCursor: last
          ? encodeCursor(
              Date.parse(String(last['updatedAt']).replace(/(\.\d{3})\d+/, '$1')),
              last.id,
            )
          : (url.searchParams.get('after') ?? null),
      });
    }

    if (method !== 'PUT') {
      hit('invalid');
      return route.fulfill({ status: 405, body: '' });
    }
    if (!key) {
      hit('invalid');
      return problem(route, 400, 'idempotency-key-required');
    }

    // A resposta guardada é por conta e por chave, como na API (outro usuário com o mesmo UUID não colide).
    const replyKey = `${account}|${key}`;
    const previous = replies.get(replyKey);
    if (previous) {
      hit('replayed');
      return route.fulfill({
        status: previous.status,
        headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
        body: previous.body,
      });
    }

    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const segments = path.split('/');
    // `sessions/<sessão>/sets/<id>` grava na coleção `sets`; `exercises/<id>/step` ajusta só o salto de carga.
    const isSet = segments[0] === 'sessions' && segments[2] === 'sets';
    const isStep = segments[0] === 'exercises' && segments[2] === 'step';
    // O programa da semana é um registro único por conta: não tem id na rota.
    const isProgram = segments[0] === 'program';
    const name = isSet ? 'sets' : segments[0];
    const id = isSet ? segments[3] : isProgram ? 'active' : segments[1];
    if (!name || !id) {
      hit('invalid');
      return route.fulfill({ status: 404, body: '' });
    }

    const clientMs = Date.parse(String(body['clientUpdatedAt'] ?? ''));
    if (Number.isFinite(clientMs) && clientMs > Date.now() + DAY_MS) {
      hit('rejected');
      return problem(route, 422, 'client-clock-ahead');
    }

    const existing = collection(account, name).get(id);
    let row: Row;
    let outcome = 'executed';
    if (isStep) {
      if (!existing) {
        hit('rejected');
        return route.fulfill({ status: 404, body: '' });
      }
      row = {
        ...existing,
        stepKg: body['stepKg'] ?? null,
        stepClientUpdatedAt: body['clientUpdatedAt'],
        updatedAt: dotnetInstant(tick()),
      };
    } else if (
      existing &&
      Number.isFinite(clientMs) &&
      clientMs < Date.parse(String(existing['clientUpdatedAt']).replace(/(\.\d{3})\d+/, '$1'))
    ) {
      // O guardado é mais novo: 200 com ele, sem mudar nada.
      row = existing;
      outcome = 'stale';
    } else {
      const base = existing ?? NEW_ROW_DEFAULTS[name]?.(id, body) ?? { id };
      row = {
        ...base,
        ...body,
        id,
        ...(isSet ? { sessionId: segments[1] } : {}),
        deleted: body['deleted'] === true,
        updatedAt: dotnetInstant(tick()),
      } as Row;
    }

    if (outcome === 'executed') {
      collection(account, name).set(id, row);
      writes.set(`${account}/${name}`, (writes.get(`${account}/${name}`) ?? 0) + 1);
    }
    executions.set(key, (executions.get(key) ?? 0) + 1);
    const stored = { status: 200, body: JSON.stringify(row) };
    replies.set(replyKey, stored);
    hit(outcome);
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: stored.body,
    });
  });

  return server;
}
