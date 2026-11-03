import { BrowserContext, Route } from '@playwright/test';
import { ALL_PERMISSIONS, IdentityMock } from '../auth/identity-mock';

export interface PcRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

export interface PcStatusBody {
  available: boolean;
  online: boolean;
  apps: { id: string; label: string }[];
}

export interface PcFailure {
  readonly status: number;
  readonly kind: string;
  readonly extra?: Record<string, unknown>;
}

export interface PcMock {
  readonly requests: PcRequest[];
  /** Os pedidos que a API real recusaria com 403 por falta da permissão `module:pc` (a tela nunca deveria fazê-los). */
  readonly denied: PcRequest[];
  status: PcStatusBody;
  /** Falha dos comandos (não da leitura do estado). */
  commandFailure: PcFailure | null;
  /** Os comandos (tudo que não é a leitura do estado), por rota. */
  sent(path: string): Record<string, unknown>[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

export const READY: PcStatusBody = {
  available: true,
  online: true,
  apps: [
    { id: 'navegador', label: 'Navegador' },
    { id: 'notas', label: 'Notas' },
  ],
};

function problem(route: Route, failure: PcFailure) {
  return route.fulfill({
    status: failure.status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: PROBLEM_BASE + failure.kind,
      title: failure.kind,
      status: failure.status,
      ...failure.extra,
    }),
  });
}

/** O que a conta da sessão aberta pode fazer, pela mesma regra do `/me` do mock de identidade. */
function permissionsOf(identity: IdentityMock): readonly string[] {
  const guest = identity.role === 'guest' ? identity.guests.at(-1) : undefined;
  return guest ? (guest.permissions ?? identity.guestPermissions) : ALL_PERMISSIONS;
}

/**
 * Simula a API do controle do PC no formato da real: login obrigatório, a permissão `module:pc` em toda rota, 204 nos
 * comandos e as mesmas regras de confirmação (suspender e desligar só valem com `confirm: true`). Nada é enviado a um PC.
 */
export async function mockPcApi(context: BrowserContext, identity: IdentityMock): Promise<PcMock> {
  const mock: PcMock = {
    requests: [],
    denied: [],
    status: { ...READY, apps: [...READY.apps] },
    commandFailure: null,
    sent: (path) =>
      mock.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body ?? {}),
  };

  await context.route('**/api/v1/pc/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/pc', '');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    const entry: PcRequest = { method, path, body };

    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, { status: 401, kind: 'unauthenticated' });
    }
    mock.requests.push(entry);
    if (!permissionsOf(identity).includes('module:pc')) {
      mock.denied.push(entry);
      return problem(route, { status: 403, kind: 'forbidden' });
    }

    if (method === 'GET' && path === '/status') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mock.status),
      });
    }
    if (method !== 'POST') return problem(route, { status: 404, kind: 'not-found' });
    if (mock.commandFailure) return problem(route, mock.commandFailure);
    if (path === '/power' && ['SLEEP', 'SHUTDOWN'].includes(String(body?.['action']))) {
      if (body?.['confirm'] !== true) return problem(route, { status: 400, kind: 'validation' });
    }
    return route.fulfill({ status: 204 });
  });

  return mock;
}
