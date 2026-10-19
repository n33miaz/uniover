import { BrowserContext, Route } from '@playwright/test';

/** Dados da conta de teste (só existem neste arquivo e nos testes; a API real não é usada). */
export const OWNER = {
  email: 'dono@exemplo.com',
  password: 'senha-de-teste-123',
  displayName: 'Dono da Casa',
};

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}

interface StoredPasskey {
  id: string;
  name: string;
  rawId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface IdentityMock {
  readonly requests: RecordedRequest[];
  /** Há sessão no servidor (equivale ao cookie de refresh válido). */
  loggedIn: boolean;
  /** A confirmação com a passkey está em vigor. */
  stepUpValid: boolean;
  /** Derruba toda chamada como se não houvesse rede. */
  offline: boolean;
  /** Espera antes de responder ao refresh (para sobrepor renovações de abas). */
  refreshDelayMs: number;
  refreshCalls: number;
  maxRefreshInFlight: number;
  readonly passkeys: StoredPasskey[];
  /** Tokens emitidos (todos começam com "eyJ", como um JWT). */
  readonly issuedTokens: string[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  });
}

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
 * Simula a API de identidade (login, refresh, logout, passkeys e confirmação) com rotas do Playwright, no
 * mesmo formato da API real. Use junto de `serviceWorkers: 'block'`: o Playwright não intercepta o que passa
 * pelo service worker.
 */
export async function mockIdentityApi(context: BrowserContext): Promise<IdentityMock> {
  let tokenCounter = 0;
  let refreshInFlight = 0;
  const mock: IdentityMock = {
    requests: [],
    loggedIn: false,
    stepUpValid: false,
    offline: false,
    refreshDelayMs: 0,
    refreshCalls: 0,
    maxRefreshInFlight: 0,
    passkeys: [],
    issuedTokens: [],
  };

  const issueToken = () => {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ sub: 'u1', n: ++tokenCounter }));
    const token = `${header}.${payload}.assinatura-${tokenCounter}`;
    mock.issuedTokens.push(token);
    return token;
  };
  const tokenBody = () => ({ accessToken: issueToken(), expiresIn: 600 });

  await context.route('**/api/v1/identity/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/identity', '');
    const method = request.method();
    const headers = request.headers();
    mock.requests.push({ method, url: request.url(), path, headers });

    if (mock.offline) return route.abort('internetdisconnected');

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    const authorized = !!bearer && mock.issuedTokens.includes(bearer);
    const hasClientHeader = headers['x-uniover-client'] === 'web';
    const body = request.postDataJSON() as Record<string, unknown> | null;

    if (method === 'GET' && path === '/info') {
      return json(route, 200, { module: 'identity', version: '0.9.0-teste', dependsOn: [] });
    }

    if (method === 'POST' && path === '/auth/login') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      if (body?.['email'] === 'bloqueado@exemplo.com') {
        return problem(route, 429, 'login-locked', 'Conta bloqueada.', {}, { 'retry-after': '3' });
      }
      if (body?.['email'] !== OWNER.email || body?.['password'] !== OWNER.password) {
        return problem(route, 401, 'unauthenticated', 'E-mail ou senha inválidos.');
      }
      mock.loggedIn = true;
      return json(route, 200, tokenBody());
    }

    if (method === 'POST' && path === '/auth/refresh') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      mock.refreshCalls++;
      mock.maxRefreshInFlight = Math.max(mock.maxRefreshInFlight, ++refreshInFlight);
      try {
        if (mock.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, mock.refreshDelayMs));
        if (!mock.loggedIn) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
        return json(route, 200, tokenBody());
      } finally {
        refreshInFlight--;
      }
    }

    if (method === 'POST' && path === '/auth/logout') {
      if (!authorized) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
      mock.loggedIn = false;
      return route.fulfill({ status: 204 });
    }

    // Tudo abaixo exige o token no cabeçalho.
    if (!authorized) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');

    if (method === 'POST' && path === '/auth/stream-ticket')
      return json(route, 200, { expiresIn: 120 });
    if (method === 'GET' && path === '/me') {
      return json(route, 200, { id: 'u1', email: OWNER.email, displayName: OWNER.displayName });
    }
    if (method === 'GET' && path === '/passkeys') {
      return json(
        route,
        200,
        mock.passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({
          id,
          name,
          createdAt,
          lastUsedAt,
        })),
      );
    }

    if (method === 'POST' && path === '/passkeys/registration/options') {
      if (body?.['password'] !== OWNER.password) {
        return problem(route, 403, 'invalid-password', 'Senha incorreta.');
      }
      return json(route, 200, {
        challengeId: `c-${mock.passkeys.length + 1}`,
        options: {
          status: 'ok',
          errorMessage: '',
          rp: { name: 'UniOver', id: 'localhost' },
          user: { id: base64url('u1'), name: OWNER.email, displayName: OWNER.displayName },
          challenge: base64url(`registro-${Date.now()}`),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 60000,
          excludeCredentials: [],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none',
          extensions: {},
        },
      });
    }

    if (method === 'POST' && path === '/passkeys/registration/complete') {
      const credential = body?.['credential'] as { rawId?: string } | undefined;
      const stored: StoredPasskey = {
        id: `p${mock.passkeys.length + 1}`,
        name: (body?.['name'] as string | null) ?? 'Passkey',
        rawId: credential?.rawId ?? '',
        createdAt: '2026-10-18T12:00:00Z',
        lastUsedAt: null,
      };
      mock.passkeys.push(stored);
      return json(route, 201, {
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        lastUsedAt: null,
      });
    }

    const passkeyMatch = /^\/passkeys\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && passkeyMatch) {
      const found = mock.passkeys.find((p) => p.id === passkeyMatch[1]);
      if (!found) return route.fulfill({ status: 404 });
      found.name = String(body?.['name']);
      return json(route, 200, {
        id: found.id,
        name: found.name,
        createdAt: found.createdAt,
        lastUsedAt: found.lastUsedAt,
      });
    }
    if (method === 'DELETE' && passkeyMatch) {
      if (!mock.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'identity.passkey-remove',
        });
      }
      if (mock.passkeys.length <= 1) {
        return problem(route, 409, 'last-passkey', 'Esta é a última passkey.');
      }
      const index = mock.passkeys.findIndex((p) => p.id === passkeyMatch[1]);
      if (index < 0) return route.fulfill({ status: 404 });
      mock.passkeys.splice(index, 1);
      mock.stepUpValid = false;
      return route.fulfill({ status: 204 });
    }

    if (method === 'POST' && path === '/step-up/options') {
      if (mock.passkeys.length === 0) return problem(route, 404, 'no-passkey', 'Nenhuma passkey.');
      return json(route, 200, {
        challengeId: 'su-1',
        options: {
          status: 'ok',
          errorMessage: '',
          challenge: base64url(`confirmacao-${Date.now()}`),
          timeout: 60000,
          rpId: 'localhost',
          allowCredentials: mock.passkeys.map((p) => ({
            type: 'public-key',
            id: p.rawId,
            transports: null,
          })),
          userVerification: 'required',
          extensions: null,
        },
      });
    }
    if (method === 'POST' && path === '/step-up/complete') {
      mock.stepUpValid = true;
      return json(route, 200, {
        action: 'identity.passkey-remove',
        expiresAt: '2026-10-18T12:05:00Z',
      });
    }

    return route.fulfill({ status: 404 });
  });

  return mock;
}
