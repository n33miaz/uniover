import { BrowserContext, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

export interface DevicesRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

interface StoredAgent {
  id: string;
  slug: string;
  name: string;
  platform: string;
  createdAt: string;
  revoked: boolean;
}

export interface DevicesMock {
  readonly requests: DevicesRequest[];
  readonly agents: StoredAgent[];
  /** Códigos que o agente "mostrou" e que ainda esperam decisão (forma guardada, sem hífen). */
  readonly openCodes: Set<string>;
}

/** Código que a API simulada responde com 429 e `Retry-After: 7`. */
export const RATE_LIMITED_CODE = 'BCDF9999';

const PROBLEM_BASE = 'https://uniover.app/problems/';

function problem(
  route: Route,
  status: number,
  kind: string,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title, status, ...extra }),
  });
}

/**
 * Simula a API de aparelhos no formato da real: aprovar exige a confirmação com a passkey (lida do estado do mock
 * de identidade) e é gasta ao aprovar; todo POST precisa de `Content-Type: application/json`, senão a API real cai
 * no fallback de `/api` e responde 404, e o teste pega a regressão.
 */
export async function mockDevicesApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<DevicesMock> {
  const mock: DevicesMock = { requests: [], agents: [], openCodes: new Set() };

  await context.route('**/api/v1/devices/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/devices', '');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    mock.requests.push({ method, path, body });

    if (identity.offline) return route.abort('internetdisconnected');
    if (method === 'POST' && !isJson) return route.fulfill({ status: 404 });

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    }

    if (method === 'GET' && path === '/agents') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mock.agents),
      });
    }

    if (method === 'POST' && path === '/pairing/approve') {
      const code = String(body?.['userCode'] ?? '');
      if (code === RATE_LIMITED_CODE) {
        return problem(
          route,
          429,
          'rate-limited',
          'Muitas tentativas.',
          {},
          { 'retry-after': '7' },
        );
      }
      if (!identity.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'devices.pair-approve',
        });
      }
      if (!mock.openCodes.has(code))
        return problem(route, 404, 'pairing-not-found', 'Não encontrado.');
      mock.openCodes.delete(code);
      identity.stepUpValid = false;
      const name = (body?.['name'] as string | null) ?? 'Agente';
      const agent: StoredAgent = {
        id: `00000000-0000-4000-8000-00000000000${mock.agents.length + 1}`,
        slug: `agent:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        platform: 'windows',
        createdAt: '2026-10-18T12:00:00Z',
        revoked: false,
      };
      mock.agents.push(agent);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          platform: 'windows',
        }),
      });
    }

    if (method === 'POST' && path === '/pairing/deny') {
      const code = String(body?.['userCode'] ?? '');
      if (!mock.openCodes.has(code))
        return problem(route, 404, 'pairing-not-found', 'Não encontrado.');
      mock.openCodes.delete(code);
      return route.fulfill({ status: 204 });
    }

    const revoke = /^\/agents\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && revoke) {
      const agent = mock.agents.find((a) => a.id === revoke[1]);
      if (!agent) return route.fulfill({ status: 404 });
      agent.revoked = true;
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: agent.id, revoked: true }),
      });
    }

    return route.fulfill({ status: 404 });
  });

  return mock;
}
