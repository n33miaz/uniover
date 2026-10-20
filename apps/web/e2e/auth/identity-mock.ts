import { randomBytes } from 'node:crypto';
import { BrowserContext, Route } from '@playwright/test';

/** Dados da conta de teste (só existem neste arquivo e nos testes; a API real não é usada). */
export const OWNER = {
  email: 'dono@exemplo.com',
  password: 'senha-de-teste-123',
  displayName: 'Dono da Casa',
};

/** A convidada que o dono convida nos testes: ela escolhe o próprio e-mail e a própria senha no aceite. */
export const GUEST = {
  email: 'convidada@exemplo.com',
  password: 'senha-da-convidada-123',
  displayName: 'Alice',
};

export interface MockInvite {
  id: string;
  displayName: string;
  /** O segredo do link, que a API só devolve na criação. */
  token: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface MockGuest {
  id: string;
  displayName: string;
  email: string;
  password: string;
  createdAt: string;
  disabledAt: string | null;
}

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
  /** Papel da sessão aberta: o que `/me` devolve e o que decide os 403 das rotas só do dono. */
  role: 'owner' | 'guest';
  readonly invites: MockInvite[];
  readonly guests: MockGuest[];
  /** Cria um convite pendente já pronto (o segredo do link é o devolvido). */
  seedInvite(displayName?: string): MockInvite;
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
    role: 'owner',
    invites: [],
    guests: [],
    seedInvite: (displayName = GUEST.displayName) => {
      const invite: MockInvite = {
        id: '00000000-0000-4000-8000-0000000000' + String(mock.invites.length + 10),
        displayName,
        token: randomBytes(32).toString('base64url'),
        status: 'pending',
        createdAt: '2026-10-19T12:00:00Z',
        expiresAt: '2026-10-21T12:00:00Z',
      };
      mock.invites.push(invite);
      return invite;
    },
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
      const guest = mock.guests.find(
        (g) => g.email === body?.['email'] && g.password === body?.['password'] && !g.disabledAt,
      );
      const isOwner = body?.['email'] === OWNER.email && body?.['password'] === OWNER.password;
      if (!isOwner && !guest) {
        return problem(route, 401, 'unauthenticated', 'E-mail ou senha inválidos.');
      }
      mock.role = isOwner ? 'owner' : 'guest';
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

    // Rota pública: quem recebeu o link ainda não tem sessão. O segredo vai no corpo, nunca na URL.
    if (method === 'POST' && path === '/guest-invites/accept') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      const invite = mock.invites.find(
        (i) => i.token === body?.['token'] && i.status === 'pending',
      );
      if (!invite) return problem(route, 410, 'invite-invalid', 'Este convite não vale mais.');
      if (String(body?.['email']).toLowerCase() === OWNER.email) {
        return problem(route, 409, 'email-unavailable', 'Este e-mail não pode ser usado.');
      }
      invite.status = 'used';
      mock.guests.push({
        id: '00000000-0000-4000-8000-0000000000' + String(mock.guests.length + 50),
        displayName: invite.displayName,
        email: String(body?.['email']),
        password: String(body?.['password']),
        createdAt: '2026-10-19T15:00:00Z',
        disabledAt: null,
      });
      mock.role = 'guest';
      mock.loggedIn = true;
      return json(route, 200, tokenBody());
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
      const guest = mock.role === 'guest' ? mock.guests.at(-1) : undefined;
      return json(route, 200, {
        id: guest?.id ?? 'u1',
        email: guest?.email ?? OWNER.email,
        displayName: guest?.displayName ?? OWNER.displayName,
        role: mock.role,
      });
    }

    // Como a API: tudo o que é da conta e dos convites é só do dono.
    if (mock.role === 'guest') return problem(route, 403, 'forbidden', 'Sem permissão.');

    if (method === 'GET' && path === '/guest-invites') {
      return json(
        route,
        200,
        mock.invites.map((i) => ({
          id: i.id,
          displayName: i.displayName,
          status: i.status,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
          usedAt: i.status === 'used' ? '2026-10-19T15:00:00Z' : null,
          revokedAt: i.status === 'revoked' ? '2026-10-19T15:00:00Z' : null,
        })),
      );
    }
    if (method === 'GET' && path === '/guests') {
      return json(
        route,
        200,
        mock.guests.map(({ id, displayName, email, createdAt, disabledAt }) => ({
          id,
          displayName,
          email,
          createdAt,
          disabledAt,
        })),
      );
    }
    if (method === 'POST' && path === '/guest-invites') {
      if (!mock.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'identity.guest-invite',
        });
      }
      const invite = mock.seedInvite(String(body?.['displayName']));
      return json(route, 200, {
        id: invite.id,
        displayName: invite.displayName,
        token: invite.token,
        expiresAt: invite.expiresAt,
      });
    }
    const inviteRevoke = /^\/guest-invites\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && inviteRevoke) {
      const found = mock.invites.find((i) => i.id === inviteRevoke[1]);
      if (!found) return route.fulfill({ status: 404 });
      found.status = 'revoked';
      return route.fulfill({ status: 204 });
    }
    const guestRevoke = /^\/guests\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && guestRevoke) {
      const found = mock.guests.find((g) => g.id === guestRevoke[1]);
      if (!found) return route.fulfill({ status: 404 });
      found.disabledAt = '2026-10-19T16:00:00Z';
      return route.fulfill({ status: 204 });
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
