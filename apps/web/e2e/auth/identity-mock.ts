import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { BrowserContext, Route } from '@playwright/test';
import { missingIdempotencyKey } from '../idempotency-guard';

/** O id da conta do dono no simulador (o `sub` dos tokens dele e o `id` do `/me`): nomeia o banco local dele no aparelho. */
export const OWNER_ID = 'u1';

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
  /** O que o convite concede (ausente vale o modelo "só controle da TV", como na API). */
  permissions?: string[];
}

export interface MockGuest {
  id: string;
  displayName: string;
  email: string;
  password: string;
  createdAt: string;
  disabledAt: string | null;
  /** O nome já foi escolhido pela pessoa (o `displayNameConfirmed` do `/me`); ausente vale como escolhido. */
  nameConfirmed?: boolean;
  /** O que a pessoa pode fazer (ausente vale `guestPermissions` do simulador). */
  permissions?: string[];
}

/** Todas as permissões do catálogo da API, na ordem em que ela as devolve (é o que o administrador tem). */
export const ALL_PERMISSIONS = [
  'module:tv',
  'tv:control',
  'tv:power',
  'tv:launch',
  'tv:edit-shortcuts',
  'tv:history',
  'module:training',
] as const;

/** O modelo "só controle da TV" da API: o que a convidada tem (a TV inteira, desligar inclusive, sem editar atalhos). */
export const TV_CONTROL_ONLY = [
  'module:tv',
  'tv:control',
  'tv:power',
  'tv:launch',
  'tv:history',
] as const;

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** Corpo JSON do pedido, quando há. */
  readonly body: unknown;
}

interface StoredPasskey {
  id: string;
  name: string;
  rawId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Um pedido de entrada pelo QR no servidor simulado (compartilhado entre o "computador" e o "celular" de um teste). */
export interface MockQrRequest {
  readonly code: string;
  readonly secret: string;
  readonly userAgent: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  /** Quem confirmou: a sessão do celular (o computador passa a ser esta conta). */
  approver?: { role: 'owner' | 'guest'; guest?: MockGuest };
}

/**
 * O lado do servidor da entrada pelo QR. Um teste com dois contextos (computador e celular) cria UM e o passa aos dois
 * `mockIdentityApi`: é o que faz o celular ver o pedido que o computador abriu.
 */
export interface QrServerMock {
  readonly requests: MockQrRequest[];
  /** Quanto o QR vale, em segundos (a tela o troca pouco antes de vencer). */
  expiresIn: number;
  /** A prova que a API pede ao celular: nada (sessão recente), a senha ou a passkey. */
  verification: 'none' | 'password' | 'passkey';
  /** O celular está na mesma rede que o computador? */
  sameNetwork: boolean;
}

export function newQrServer(): QrServerMock {
  return { requests: [], expiresIn: 120, verification: 'none', sameNetwork: true };
}

export interface IdentityMock {
  readonly requests: RecordedRequest[];
  /** O servidor simulado da entrada pelo QR (o mesmo objeto nos dois contextos de um teste de entrada cruzada). */
  readonly qr: QrServerMock;
  /** Há sessão no servidor (equivale ao cookie de refresh válido). */
  loggedIn: boolean;
  /** A confirmação com a passkey (ou, para o convidado, com a senha) está em vigor. */
  stepUpValid: boolean;
  /** As confirmações com a senha que o convidado fez (`POST /step-up/password`): a ação e a senha enviada. */
  readonly passwordConfirmations: { action: string; password: string }[];
  /** Derruba toda chamada como se não houvesse rede. */
  offline: boolean;
  /** Espera antes de responder ao refresh (para sobrepor renovações de abas). */
  refreshDelayMs: number;
  refreshCalls: number;
  maxRefreshInFlight: number;
  /**
   * Quantas respostas de refresh se perdem daqui para a frente: o servidor gira o token e o navegador não recebe a
   * resposta (a página do iPhone suspensa no meio da renovação). Enquanto a resposta estiver perdida, o refresh COMUM com
   * o cookie antigo é reuso e derruba a sessão (a regra estrita); só a recuperação comprovada passa.
   */
  loseNextRefreshResponses: number;
  /** A chave pública que o navegador mandou na última entrada (senha, convite ou QR). */
  deviceKey: string | null;
  /** O que a recuperação fez: desafios emitidos, recuperações aceitas e a sessão derrubada por reuso. */
  recovery: { challenges: number; recovered: number; revokedByReuse: boolean };
  readonly passkeys: StoredPasskey[];
  /** Papel da sessão aberta: o que `/me` devolve e o que decide os 403 das rotas só do dono. */
  role: 'owner' | 'guest';
  /** O nome do dono e se ele já o escolheu: o que `/me` devolve e o que `PATCH /me` grava. Começa como dono que já escolheu. */
  readonly owner: { displayName: string; confirmed: boolean };
  /** Quem aceita um convite nasce sem ter escolhido o nome (como na API). Desligado por padrão: os testes antigos só passam por aqui. */
  guestsStartUnconfirmed: boolean;
  /** As permissões que `/me` devolve para a convidada. */
  guestPermissions: string[];
  /** Faz `PATCH /me` responder 429 com este `Retry-After` (segundos). */
  patchRetryAfter: number | null;
  /** Faz `PATCH /me` responder 403 (conta sem acesso). */
  patchForbidden: boolean;
  readonly invites: MockInvite[];
  readonly guests: MockGuest[];
  sessions: MockSession[];
  readonly guestSessions: Record<string, MockSession[]>;
  /** Cria um convite pendente já pronto (o segredo do link é o devolvido). */
  seedInvite(displayName?: string, permissions?: string[]): MockInvite;
  /** Tokens emitidos (todos começam com "eyJ", como um JWT). */
  readonly issuedTokens: string[];
}

export interface MockSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

/** As ações da TV: cada uma só vale com o módulo da TV. */
const TV_ACTIONS: readonly string[] = ALL_PERMISSIONS.filter((p) => p.startsWith('tv:'));

/**
 * As regras da API para uma lista de permissões (criar convite e mudar as de um convidado), com os mesmos textos:
 * obrigatória, só do catálogo, ao menos um módulo e toda ação da TV com o módulo dela. Devolve os erros ou `null`.
 */
function permissionErrors(requested: unknown): string[] | null {
  if (!Array.isArray(requested)) return ['Informe a lista de permissões.'];
  const errors: string[] = [];
  const list = requested as string[];
  if (list.some((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p))) {
    errors.push('A lista tem uma permissão que não existe.');
  }
  if (!list.some((p) => p === 'module:tv' || p === 'module:training')) {
    errors.push('Escolha ao menos um módulo (TV ou Treino) para dar acesso.');
  }
  if (list.some((p) => TV_ACTIONS.includes(p)) && !list.includes('module:tv')) {
    errors.push('Uma permissão da TV precisa do módulo da TV na lista.');
  }
  return errors.length > 0 ? errors : null;
}

/** A lista na ordem do catálogo e sem repetidas, como a API a grava e devolve. */
function inCatalogOrder(list: string[]): string[] {
  return ALL_PERMISSIONS.filter((p) => list.includes(p));
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

type NameResult = { ok: true; name: string } | { ok: false; message: string };

/**
 * As regras de nome da API, resumidas (as mensagens são as dela): Unicode composto, espaços das pontas e repetidos
 * limpos, de 1 a 60 caracteres (pontos de código), sem caractere de controle nem invisível e com alguma letra, número
 * ou símbolo.
 */
function normalizeName(raw: unknown): NameResult {
  const empty = { ok: false, message: 'Informe seu nome.' } as const;
  if (typeof raw !== 'string') return empty;
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    return {
      ok: false,
      message:
        'Use só letras, números, espaços e emojis comuns, sem caracteres invisíveis ou de controle.',
    };
  }
  if (!/[\p{L}\p{N}\p{S}]/u.test(name)) return empty;
  if (Array.from(name).length > 60) {
    return { ok: false, message: 'O nome pode ter até 60 caracteres.' };
  }
  return { ok: true, name };
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
export async function mockIdentityApi(
  context: BrowserContext,
  options: { qr?: QrServerMock } = {},
): Promise<IdentityMock> {
  let tokenCounter = 0;
  let refreshInFlight = 0;
  /** O servidor girou o token e a resposta se perdeu: o cookie do navegador é o antigo. */
  let rotationLost = false;
  let issuedChallenge: { id: string; nonce: string; used: boolean } | null = null;
  const FAMILY = 'f'.repeat(32);
  const mock: IdentityMock = {
    requests: [],
    qr: options.qr ?? newQrServer(),
    loggedIn: false,
    stepUpValid: false,
    passwordConfirmations: [],
    offline: false,
    refreshDelayMs: 0,
    refreshCalls: 0,
    maxRefreshInFlight: 0,
    loseNextRefreshResponses: 0,
    deviceKey: null,
    recovery: { challenges: 0, recovered: 0, revokedByReuse: false },
    passkeys: [],
    role: 'owner',
    owner: { displayName: OWNER.displayName, confirmed: true },
    guestsStartUnconfirmed: false,
    guestPermissions: [...TV_CONTROL_ONLY],
    patchRetryAfter: null,
    patchForbidden: false,
    invites: [],
    guests: [],
    sessions: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        userAgent: 'Mozilla/5.0 (iPhone) Safari/605.1.15',
        ip: '192.0.2.0/24',
        createdAt: '2026-10-25T10:00:00Z',
        lastUsedAt: '2026-10-26T10:00:00Z',
        isCurrent: true,
      },
    ],
    guestSessions: {},
    seedInvite: (displayName = GUEST.displayName, permissions) => {
      const invite: MockInvite = {
        id: '00000000-0000-4000-8000-0000000000' + String(mock.invites.length + 10),
        displayName,
        token: randomBytes(32).toString('base64url'),
        status: 'pending',
        createdAt: '2026-10-19T12:00:00Z',
        expiresAt: '2026-10-21T12:00:00Z',
        permissions,
      };
      mock.invites.push(invite);
      return invite;
    },
    issuedTokens: [],
  };

  /** O id da conta da sessão aberta (o do dono, ou o do convidado mais recente quando o papel é o de convidado). */
  const sessionAccountId = () =>
    (mock.role === 'guest' ? mock.guests.at(-1)?.id : undefined) ?? OWNER_ID;

  const issueToken = () => {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    // O `sub` é a conta a quem o token pertence, como na API: é por ele que os simuladores sabem quem está chamando.
    const payload = base64url(JSON.stringify({ sub: sessionAccountId(), n: ++tokenCounter }));
    const token = `${header}.${payload}.assinatura-${tokenCounter}`;
    mock.issuedTokens.push(token);
    return token;
  };
  const tokenBody = () => ({ accessToken: issueToken(), expiresIn: 600 });
  /** A conta da sessão aberta, como `GET /me` e `PATCH /me` a devolvem. */
  const meBody = () => {
    const guest = mock.role === 'guest' ? mock.guests.at(-1) : undefined;
    return {
      id: guest?.id ?? OWNER_ID,
      email: guest?.email ?? OWNER.email,
      displayName: guest?.displayName ?? mock.owner.displayName,
      role: mock.role,
      displayNameConfirmed: guest ? guest.nameConfirmed !== false : mock.owner.confirmed,
      permissions: guest ? [...(guest.permissions ?? mock.guestPermissions)] : [...ALL_PERMISSIONS],
    };
  };

  /** A mesma conferência da API: desafio de uso único e assinatura da chave da família sobre a mensagem combinada. */
  const recoveryProofIsValid = (challenge?: string, proof?: string): boolean => {
    if (!challenge || !proof || !issuedChallenge || issuedChallenge.used || !mock.deviceKey) return false;
    if (challenge !== `${issuedChallenge.id}.${issuedChallenge.nonce}`) return false;
    issuedChallenge.used = true;
    const message = `uniover-refresh-recovery|v1|${FAMILY}|${issuedChallenge.id}|${issuedChallenge.nonce}`;
    try {
      return verify(
        'sha256',
        Buffer.from(message),
        { key: createPublicKey({ key: Buffer.from(mock.deviceKey, 'base64url'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(proof, 'base64url'),
      );
    } catch {
      return false;
    }
  };

  await context.route('**/health/version', async (route) => {
    const request = route.request();
    const method = request.method();
    const headers = request.headers();
    mock.requests.push({
      method,
      url: request.url(),
      path: '/health/version',
      headers,
      body: null,
    });

    if (mock.offline) return route.abort('internetdisconnected');
    if (method !== 'GET') return problem(route, 405, 'method-not-allowed', 'Método não aceito.');
    return json(route, 200, { commit: 'a'.repeat(40), version: '0.5.0-teste' });
  });

  await context.route('**/api/v1/identity/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/identity', '');
    const method = request.method();
    const headers = request.headers();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    mock.requests.push({ method, url: request.url(), path, headers, body });

    if (mock.offline) return route.abort('internetdisconnected');

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    const authorized = !!bearer && mock.issuedTokens.includes(bearer);
    const hasClientHeader = headers['x-uniover-client'] === 'web';
    // O mock cobra a chave nas escritas do site novo, embora a API aceite clientes antigos nesta transição.
    if (authorized && missingIdempotencyKey(method, url.pathname, headers)) {
      return problem(
        route,
        400,
        'idempotency-key-required',
        'Informe o cabeçalho Idempotency-Key com um UUID.',
      );
    }

    if (method === 'GET' && path === '/info') {
      return json(route, 200, { module: 'identity', version: '0.9.0-teste', dependsOn: [] });
    }

    if (method === 'POST' && ['/auth/login', '/auth/qr/poll', '/guest-invites/accept'].includes(path)) {
      mock.deviceKey = headers['x-uniover-device-key'] ?? null;
      rotationLost = false;
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

        if (rotationLost) {
          // O cookie do navegador é o antigo, já girado: só a recuperação comprovada passa.
          const recovered = recoveryProofIsValid(
            headers['x-uniover-recovery-challenge'],
            headers['x-uniover-recovery-proof'],
          );
          if (!recovered) {
            mock.loggedIn = false;
            mock.recovery.revokedByReuse = true;
            return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
          }
          rotationLost = false;
          mock.recovery.recovered++;
          return json(route, 200, tokenBody());
        }

        if (mock.loseNextRefreshResponses > 0) {
          mock.loseNextRefreshResponses--;
          rotationLost = true;
          return route.abort('failed');
        }
        return json(route, 200, tokenBody());
      } finally {
        refreshInFlight--;
      }
    }

    if (method === 'POST' && path === '/auth/refresh/challenge') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      if (!mock.loggedIn) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
      if (!rotationLost) return json(route, 200, { challenge: null, familyId: null, expiresIn: 0 });
      issuedChallenge = {
        id: randomBytes(16).toString('hex'),
        nonce: randomBytes(32).toString('base64url'),
        used: false,
      };
      mock.recovery.challenges++;
      return json(route, 200, {
        challenge: `${issuedChallenge.id}.${issuedChallenge.nonce}`,
        familyId: FAMILY,
        expiresIn: 120,
      });
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
        nameConfirmed: !mock.guestsStartUnconfirmed,
        // Só leva as permissões do convite quando ele as tem: convite semeado sem lista deixa a conta com
        // `guestPermissions`, como antes (testes que ajustam esse valor seguem valendo).
        ...(invite.permissions ? { permissions: [...invite.permissions] } : {}),
      });
      mock.role = 'guest';
      mock.loggedIn = true;
      return json(route, 200, tokenBody());
    }

    // Entrada pelo QR, lado do computador (anônimo): abre o pedido e consulta com o segredo que só ele tem.
    if (method === 'POST' && path === '/auth/qr/start') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      const entry: MockQrRequest = {
        code: `Qr${mock.qr.requests.length + 1}aaaaaaaaaaaaaa`.slice(0, 16),
        secret: randomBytes(32).toString('base64url'),
        userAgent: headers['user-agent'] ?? '',
        status: 'pending',
      };
      mock.qr.requests.push(entry);
      return json(route, 200, {
        code: entry.code,
        pollSecret: entry.secret,
        expiresAt: '2026-10-24T12:02:00Z',
        expiresIn: mock.qr.expiresIn,
      });
    }
    if (method === 'POST' && path === '/auth/qr/poll') {
      if (!hasClientHeader) return problem(route, 400, 'validation-failed', 'Cabeçalho ausente.');
      const entry = mock.qr.requests.find((r) => r.secret === body?.['secret']);
      if (!entry || entry.status === 'consumed') return json(route, 200, { status: 'expired' });
      if (entry.status === 'pending') return json(route, 200, { status: 'pending' });
      if (entry.status === 'denied') return json(route, 200, { status: 'denied' });
      // Aprovado: este computador vira uma sessão da MESMA conta que confirmou, uma vez só.
      entry.status = 'consumed';
      mock.role = entry.approver?.role ?? 'owner';
      const guest = entry.approver?.guest;
      if (guest && !mock.guests.some((g) => g.id === guest.id)) mock.guests.push(guest);
      mock.loggedIn = true;
      return json(route, 200, { status: 'approved', ...tokenBody() });
    }

    if (method === 'POST' && path === '/auth/logout') {
      if (!authorized) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
      mock.loggedIn = false;
      return route.fulfill({ status: 204 });
    }

    // Tudo abaixo exige o token no cabeçalho.
    if (!authorized) return problem(route, 401, 'unauthenticated', 'Sessão inválida.');

    if (method === 'GET' && path === '/sessions') return json(route, 200, mock.sessions);
    if (method === 'POST' && path === '/sessions/others/revoke') {
      mock.sessions = mock.sessions.filter((session) => session.isCurrent);
      return route.fulfill({ status: 204 });
    }
    const ownSession = /^\/sessions\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && ownSession) {
      const id = ownSession[1];
      const session = mock.sessions.find((item) => item.id === id);
      if (!session) return problem(route, 404, 'not-found', 'Sessão não encontrada.');
      mock.sessions = mock.sessions.filter((item) => item.id !== id);
      if (session.isCurrent) mock.loggedIn = false;
      return route.fulfill({ status: 204 });
    }

    // Entrada pelo QR, lado do celular (com sessão): ver, confirmar e recusar.
    if (method === 'POST' && path.startsWith('/auth/qr/')) {
      const entry = mock.qr.requests.find((r) => r.code === body?.['code']);
      if (!entry || entry.status !== 'pending') {
        return problem(route, 410, 'qr-invalid', 'Este QR não vale mais.');
      }
      if (path === '/auth/qr/info') {
        return json(route, 200, {
          userAgent: entry.userAgent,
          sameNetwork: mock.qr.sameNetwork,
          expiresAt: '2026-10-24T12:02:00Z',
          verification: mock.qr.verification,
        });
      }
      if (path === '/auth/qr/deny') {
        entry.status = 'denied';
        return route.fulfill({ status: 204 });
      }
      if (path === '/auth/qr/approve') {
        if (mock.qr.verification === 'passkey' && !mock.stepUpValid) {
          return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
            code: 'step_up_required',
            action: 'identity.qr-login-approve',
          });
        }
        const account = mock.role === 'guest' ? mock.guests.at(-1) : undefined;
        if (mock.qr.verification === 'password') {
          if (!body?.['password']) {
            return problem(route, 403, 'qr-reauth-required', 'Digite a sua senha.');
          }
          if (body['password'] !== (account?.password ?? OWNER.password)) {
            return problem(route, 403, 'invalid-password', 'Senha incorreta.');
          }
        }
        entry.status = 'approved';
        entry.approver = { role: mock.role, guest: account };
        return route.fulfill({ status: 204 });
      }
    }

    if (method === 'POST' && path === '/auth/stream-ticket')
      return json(route, 200, { expiresIn: 120 });
    if (method === 'GET' && path === '/me') return json(route, 200, meBody());

    // Cada pessoa muda só o próprio nome (dono ou convidada ativa): vem antes do 403 das rotas só do dono, como na API.
    if (method === 'PATCH' && path === '/me') {
      if (mock.patchForbidden) return problem(route, 403, 'forbidden', 'Sem permissão.');
      if (mock.patchRetryAfter !== null) {
        return problem(
          route,
          429,
          'rate-limited',
          'Muitas tentativas.',
          {},
          { 'retry-after': String(mock.patchRetryAfter) },
        );
      }
      const result = normalizeName(body?.['displayName']);
      if (!result.ok) {
        return problem(route, 400, 'validation-failed', 'Um ou mais campos são inválidos.', {
          errors: { displayName: [result.message] },
        });
      }
      const guest = mock.role === 'guest' ? mock.guests.at(-1) : undefined;
      if (guest) {
        guest.displayName = result.name;
        guest.nameConfirmed = true;
      } else {
        mock.owner.displayName = result.name;
        mock.owner.confirmed = true;
      }
      return json(route, 200, meBody());
    }

    // O passo forte do convidado, que não tem passkey: a senha de novo, só para a ação da lista fechada da API (vem antes do 403 das rotas só do dono: só o convidado a usa).
    if (method === 'POST' && path === '/step-up/password') {
      const guest = mock.role === 'guest' ? mock.guests.at(-1) : undefined;
      if (!guest) return problem(route, 403, 'forbidden', 'Esta confirmação é só para convidados.');
      const action = String(body?.['action'] ?? '');
      const password = String(body?.['password'] ?? '');
      if (action !== 'devices.pair-self') {
        return problem(route, 400, 'validation-failed', 'Um ou mais campos são inválidos.', {
          errors: { action: ['Esta ação não pode ser confirmada com a senha.'] },
        });
      }
      mock.passwordConfirmations.push({ action, password });
      if (password !== guest.password) {
        return problem(route, 403, 'invalid-password', 'Senha incorreta.');
      }
      mock.stepUpValid = true;
      return json(route, 200, { action, expiresAt: '2026-10-18T12:05:00Z' });
    }
    // Como a API: tudo o que é da conta e dos convites é só do dono.
    if (mock.role === 'guest') return problem(route, 403, 'forbidden', 'Sem permissão.');

    const guestSessionList = /^\/guests\/([^/]+)\/sessions$/.exec(path);
    if (method === 'GET' && guestSessionList) {
      return json(route, 200, mock.guestSessions[guestSessionList[1]] ?? []);
    }
    const guestSessionRevoke = /^\/guests\/([^/]+)\/sessions\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && guestSessionRevoke) {
      const list = mock.guestSessions[guestSessionRevoke[1]] ?? [];
      mock.guestSessions[guestSessionRevoke[1]] = list.filter(
        (item) => item.id !== guestSessionRevoke[2],
      );
      return route.fulfill({ status: 204 });
    }

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
          permissions: i.permissions ?? [...TV_CONTROL_ONLY],
        })),
      );
    }
    // Uso por pessoa (só contagens): números fixos, para os testes conferirem o que a tela mostra.
    if (method === 'GET' && path === '/people-usage') {
      const counts = { last7Days: 12, last30Days: 40 };
      const workouts = { last7Days: 3, last30Days: 9 };
      return json(route, 200, [
        {
          id: OWNER_ID,
          displayName: mock.owner.displayName,
          role: 'owner',
          disabledAt: null,
          lastAccessAt: new Date().toISOString(),
          activeSessions: 1,
          tvCommands: counts,
          workouts,
        },
        ...mock.guests.map((guest) => ({
          id: guest.id,
          displayName: guest.displayName,
          role: 'guest',
          disabledAt: guest.disabledAt,
          lastAccessAt: guest.disabledAt
            ? null
            : new Date(Date.now() - 3 * 3_600_000).toISOString(),
          activeSessions: guest.disabledAt ? 0 : 2,
          tvCommands: counts,
          workouts,
        })),
      ]);
    }
    if (method === 'GET' && path === '/guests') {
      return json(
        route,
        200,
        mock.guests.map(({ id, displayName, email, createdAt, disabledAt, permissions }) => ({
          id,
          displayName,
          email,
          createdAt,
          disabledAt,
          permissions: permissions ?? [...mock.guestPermissions],
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
      // Sem lista vale o modelo "só controle da TV"; lista vazia, desconhecida ou incompleta é 400, com os textos da API.
      const requested = body && 'permissions' in body ? body['permissions'] : [...TV_CONTROL_ONLY];
      const errors = permissionErrors(requested);
      if (errors) {
        return problem(route, 400, 'validation-failed', 'Um ou mais campos são inválidos.', {
          errors: { permissions: errors },
        });
      }
      const invite = mock.seedInvite(
        String(body?.['displayName']),
        inCatalogOrder(requested as string[]),
      );
      return json(route, 200, {
        id: invite.id,
        displayName: invite.displayName,
        token: invite.token,
        expiresAt: invite.expiresAt,
        permissions: invite.permissions,
      });
    }
    const inviteRevoke = /^\/guest-invites\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && inviteRevoke) {
      const found = mock.invites.find((i) => i.id === inviteRevoke[1]);
      if (!found) return route.fulfill({ status: 404 });
      found.status = 'revoked';
      return route.fulfill({ status: 204 });
    }
    // Mudar as permissões de um convidado: só o dono e com a passkey; a lista vai COMPLETA e a resposta é o convidado.
    const permissionsRoute = /^\/guests\/([^/]+)\/permissions$/.exec(path);
    if (method === 'PUT' && permissionsRoute) {
      if (!mock.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'identity.permissions-change',
        });
      }
      const errors = permissionErrors(body?.['permissions']);
      if (errors) {
        return problem(route, 400, 'validation-failed', 'Um ou mais campos são inválidos.', {
          errors: { permissions: errors },
        });
      }
      const found = mock.guests.find((g) => g.id === permissionsRoute[1]);
      if (!found) return route.fulfill({ status: 404 });
      if (found.disabledAt) {
        return problem(route, 409, 'guest-revoked', 'O acesso deste convidado foi revogado.');
      }
      found.permissions = inCatalogOrder(body?.['permissions'] as string[]);
      const { id, displayName, email, createdAt, disabledAt } = found;
      return json(route, 200, {
        id,
        displayName,
        email,
        createdAt,
        disabledAt,
        permissions: found.permissions,
      });
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
