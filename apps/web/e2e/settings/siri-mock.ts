import { BrowserContext, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

export interface SiriRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

export interface MockSiriKey {
  id: string;
  name: string;
  tvId: string;
  tvName: string;
  actions: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface SiriMock {
  readonly requests: SiriRequest[];
  readonly keys: MockSiriKey[];
  /** O segredo que a próxima criação devolve. */
  nextToken: string;
  /** Nomes das TVs por id, para a lista (a API real as lê do banco). */
  tvNames: Record<string, string>;
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

function problem(route: Route, status: number, kind: string, title: string, extra = {}) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title, status, ...extra }),
  });
}

/**
 * Simula as chaves dos Atalhos no formato da API real: só o administrador, criar pede a passkey (a confirmação vale uma
 * vez, como no mock da identidade) e o segredo sai só na resposta da criação. Registrado DEPOIS do mock da TV: a rota
 * registrada por último vence, e as duas moram sob `/api/v1/tv/`.
 */
export async function mockSiriApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<SiriMock> {
  const mock: SiriMock = {
    requests: [],
    keys: [],
    nextToken: 'atalho_segredo-de-teste',
    tvNames: {},
  };

  await context.route('**/api/v1/tv/siri/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/tv', '');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    mock.requests.push({ method, path, body });

    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    }
    if (identity.role !== 'owner') return problem(route, 403, 'forbidden', 'Sem acesso.');

    if (method === 'GET' && path === '/siri/tokens') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: mock.keys }),
      });
    }

    if (method === 'POST' && path === '/siri/tokens') {
      if (!identity.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'tv.siri-token',
        });
      }
      identity.stepUpValid = false;
      if (mock.keys.length >= 10)
        return problem(route, 409, 'siri-too-many-tokens', 'Muitas chaves.');
      const tvId = String(body?.['tvId'] ?? '');
      const days = typeof body?.['expiresInDays'] === 'number' ? body['expiresInDays'] : null;
      const created: MockSiriKey = {
        id: `key-${mock.keys.length + 1}`,
        name: String(body?.['name'] ?? ''),
        tvId,
        tvName: mock.tvNames[tvId] ?? 'TV',
        actions: [...((body?.['actions'] as string[] | undefined) ?? [])],
        createdAt: '2026-10-31T12:00:00Z',
        expiresAt: days ? '2026-11-30T12:00:00Z' : null,
        lastUsedAt: null,
      };
      mock.keys.unshift(created);
      return route.fulfill({
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...created, token: mock.nextToken }),
      });
    }

    const revoke = /^\/siri\/tokens\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && revoke) {
      const index = mock.keys.findIndex((key) => key.id === revoke[1]);
      if (index < 0) return problem(route, 404, 'not-found', 'Não encontrada.');
      mock.keys.splice(index, 1);
      return route.fulfill({ status: 204 });
    }

    return problem(route, 404, 'not-found', 'Não encontrada.');
  });

  return mock;
}
