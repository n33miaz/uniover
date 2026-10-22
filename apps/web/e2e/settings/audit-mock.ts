import { BrowserContext, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

/** Uma linha da trilha no formato da API (`AuditItem`). */
export interface MockAuditItem {
  id: string;
  module: 'identity' | 'devices' | 'tv';
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  occurredAt: string;
  actor: { id: string; displayName: string | null } | null;
  target: string | null;
  targetAccount: { id: string; displayName: string | null } | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditRequest {
  readonly path: string;
  readonly query: URLSearchParams;
}

export interface AuditMock {
  readonly requests: AuditRequest[];
  /** A trilha, da mais nova para a mais velha. */
  items: MockAuditItem[];
  /** Quantas leituras da lista seguintes respondem 500. */
  failList: number;
  /** O servidor corta a exportação (cabeçalho `X-Audit-Truncated`). */
  truncateExport: boolean;
  /** Só as leituras da lista e só as da exportação (a das fontes fica de fora). */
  readonly listRequests: () => AuditRequest[];
  readonly exportRequests: () => AuditRequest[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

const SOURCES = {
  outcomes: ['success', 'failure', 'denied'],
  sources: [
    {
      module: 'devices',
      retentionDays: 180,
      actions: ['pairing_started', 'pairing_approved', 'pairing_denied', 'agent_revoked'],
    },
    {
      module: 'identity',
      retentionDays: 180,
      actions: [
        'login_succeeded',
        'login_failed',
        'login_locked',
        'logout',
        'permissions_changed',
        'guest_invite_created',
        'audit_exported',
      ],
    },
    {
      module: 'tv',
      retentionDays: 30,
      actions: ['tv.key', 'tv.text', 'tv.app.launch', 'tv.power-off', 'tv.wake'],
    },
  ],
};

function problem(route: Route, status: number, kind: string, title: string) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title, status }),
  });
}

function matches(item: MockAuditItem, query: URLSearchParams): boolean {
  const person = query.get('person');
  const modules = query.getAll('module');
  const actions = query.getAll('action');
  const outcome = query.get('outcome');
  const from = query.get('from');
  if (person && item.actor?.id !== person && item.targetAccount?.id !== person) return false;
  if (modules.length > 0 && !modules.includes(item.module)) return false;
  if (actions.length > 0 && !actions.includes(item.action)) return false;
  if (outcome && item.outcome !== outcome) return false;
  if (from && Date.parse(item.occurredAt) < Date.parse(from)) return false;
  return true;
}

/** O cursor da API é opaco; o do mock é só o deslocamento na lista já filtrada. */
const encodeCursor = (offset: number) => Buffer.from(`o${offset}`).toString('base64url');
function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, 'base64url').toString();
  const value = /^o(\d+)$/.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/** O servidor começa o CSV pela marca de ordem de bytes, para o Excel abrir os acentos. */
const BOM = String.fromCharCode(0xfeff);

function csv(items: MockAuditItem[]): string {
  const header = 'occurredAt,module,action,outcome,actorId,actorName,target,ip,userAgent';
  const rows = items.map((i) =>
    [
      i.occurredAt,
      i.module,
      i.action,
      i.outcome,
      i.actor?.id,
      i.actor?.displayName,
      i.target,
      i.ip,
      i.userAgent,
    ]
      .map((cell) => `"${(cell ?? '').replaceAll('"', '""')}"`)
      .join(','),
  );
  return `${BOM}${[header, ...rows].join('\r\n')}\r\n`;
}

/**
 * Simula as três rotas da trilha no formato da API real: só o administrador lê (token válido do mock de identidade), a
 * lista segue o cursor, os filtros combinam com E e a exportação devolve o CSV, com o aviso de corte quando o teste o liga.
 * Registre depois de `mockIdentityApi`: a rota registrada por último vence.
 */
export async function mockAuditApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<AuditMock> {
  const requests: AuditRequest[] = [];
  const mock: AuditMock = {
    requests,
    items: [],
    failList: 0,
    truncateExport: false,
    listRequests: () => requests.filter((r) => r.path === '/audit'),
    exportRequests: () => requests.filter((r) => r.path === '/audit/export'),
  };

  await context.route('**/api/v1/identity/audit**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/identity', '');
    requests.push({ path, query: url.searchParams });

    if (identity.offline) return route.abort('internetdisconnected');

    const bearer = request.headers()['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    }
    // Como a API: a trilha é só do administrador, qualquer que seja a lista de permissões do convidado.
    if (identity.role !== 'owner') return problem(route, 403, 'forbidden', 'Sem permissão.');

    if (path === '/audit/sources') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(SOURCES),
      });
    }

    if (path === '/audit') {
      if (mock.failList > 0) {
        mock.failList -= 1;
        return problem(route, 500, 'internal-error', 'Erro.');
      }
      const filtered = mock.items.filter((item) => matches(item, url.searchParams));
      const offset = decodeCursor(url.searchParams.get('cursor'));
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (offset === null) return problem(route, 400, 'validation-failed', 'Cursor inválido.');
      const items = filtered.slice(offset, offset + limit);
      const more = offset + limit < filtered.length;
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, nextCursor: more ? encodeCursor(offset + limit) : null }),
      });
    }

    if (path === '/audit/export') {
      const filtered = mock.items.filter((item) => matches(item, url.searchParams));
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename=auditoria-20261021-1500.csv',
          ...(mock.truncateExport ? { 'x-audit-truncated': 'true' } : {}),
        },
        body: csv(filtered),
      });
    }

    return route.fulfill({ status: 404 });
  });

  return mock;
}
