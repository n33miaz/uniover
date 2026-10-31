import { BrowserContext, Route } from '@playwright/test';
import { missingIdempotencyKey } from '../idempotency-guard';
import { IdentityMock } from '../auth/identity-mock';

export interface DevicesRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

export interface StoredAgent {
  id: string;
  slug: string;
  name: string;
  platform: string;
  createdAt: string;
  revoked: boolean;
  lastSeenAt: string | null;
  connected: boolean;
  agentVersion: string | null;
  agentBuild: string | null;
  os: string | null;
  tvKind: string | null;
  tvHost: string | null;
  canReadLogs: boolean;
  canMaintain: boolean;
  canRollback: boolean;
  /** O estado da auto-atualização; `null` é o agente antigo, que nunca o contou. */
  update: StoredUpdate | null;
}

export interface StoredUpdate {
  state: 'current' | 'updating' | 'pending' | 'failed' | 'blocked' | 'rolled_back' | 'unchecked';
  installedSha: string | null;
  installedAt: string | null;
  latestSha: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  reason: string | null;
  blockedSha: string | null;
  previousSha: string | null;
  rolledBack: boolean;
}

export const INSTALLED_SHA = '3f2a9c1d4e5b6a7988776655443322110fedcba9';
export const NEWER_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const PREVIOUS_SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

/** O estado de um agente em dia; cada teste troca o que precisa. */
export function storedUpdate(overrides: Partial<StoredUpdate> = {}): StoredUpdate {
  return {
    state: 'current',
    installedSha: INSTALLED_SHA,
    installedAt: '2026-10-20T09:15:00Z',
    latestSha: INSTALLED_SHA,
    checkedAt: '2026-10-24T13:40:00Z',
    nextCheckAt: '2026-10-24T19:55:00Z',
    reason: null,
    blockedSha: null,
    previousSha: null,
    rolledBack: false,
    ...overrides,
  };
}

/** Um agente como a API o lista, de versão nova e conectado; cada teste ajusta o que precisa. */
export function storedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'agent:pc-de-casa',
    name: 'PC de casa',
    platform: 'windows',
    createdAt: '2026-10-18T12:00:00Z',
    revoked: false,
    lastSeenAt: '2026-10-18T15:30:00Z',
    connected: true,
    agentVersion: '0.1.0',
    agentBuild: '3f2a9c1d4e5b',
    os: 'Windows 11 (10.0.26200)',
    tvKind: 'android',
    tvHost: '192.168.0.20',
    canReadLogs: true,
    canMaintain: true,
    canRollback: false,
    update: storedUpdate(),
    ...overrides,
  };
}

/** O que a API simulada responde ao pedido do registro de um agente (a de verdade fala com o agente pelo canal). */
export interface LogReply {
  /** Texto devolvido; omitido, a API responde com o problema `problem`. */
  text?: string;
  truncated?: boolean;
  problem?: { status: number; kind: string };
}

export const DEFAULT_LOG = Array.from(
  { length: 120 },
  (_, n) =>
    `2026-10-24 14:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')},000 INFO uniover_agent.core.connection: linha ${n + 1} do registro, com bastante texto para passar da largura da tela`,
).join('\n');

/** A TV que a API real cria junto da aprovação quando o corpo traz `tvMemberIds`. */
export interface StoredTv {
  readonly name: string;
  readonly agentSlug: string;
  readonly memberIds: readonly string[];
}

/** Um aviso do computador (queda ou falha de atualização), como a API o devolve. */
export interface StoredAlert {
  id: string;
  agentId: string;
  agentName: string;
  detectedAt: string;
  lastSeenAt: string | null;
  recoveredAt: string | null;
  kind?: 'offline' | 'update_failed';
  detail?: string | null;
}

export interface DevicesMock {
  readonly requests: DevicesRequest[];
  /** Avisos de queda ainda não vistos; "Dispensar" tira um por vez. */
  readonly alerts: StoredAlert[];
  readonly agents: StoredAgent[];
  readonly tvs: StoredTv[];
  /** Códigos que o agente "mostrou" e que ainda esperam decisão (forma guardada, sem hífen). */
  readonly openCodes: Set<string>;
  /** Resposta ao pedido de registro; o padrão é um registro comprido, sem corte. */
  log: LogReply;
  /** Problema que a manutenção devolve em vez de aceitar (depois da passkey). */
  maintenanceProblem: { status: number; kind: string } | null;
  /** Quantos computadores ativos o convidado pode ter (a API real: 2). */
  guestLimit: number;
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
 * de identidade) e é gasta ao aprovar; todo POST com corpo precisa de `Content-Type: application/json`, senão a API real
 * responde 415, e o teste pega a regressão.
 */
export async function mockDevicesApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<DevicesMock> {
  const mock: DevicesMock = {
    requests: [],
    alerts: [],
    agents: [],
    tvs: [],
    openCodes: new Set(),
    log: { text: DEFAULT_LOG },
    maintenanceProblem: null,
    guestLimit: 2,
  };

  await context.route('**/api/v1/devices/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/devices', '');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    mock.requests.push({ method, path, body });

    if (identity.offline) return route.abort('internetdisconnected');
    // Corpo sem Content-Type JSON: a API real responde 415 (corpo opcional ausente passa; este cliente sempre manda JSON).
    if (method === 'POST' && request.postData() && !isJson) {
      return problem(route, 415, 'unsupported-media-type', 'Tipo de conteúdo não suportado.');
    }

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    }
    if (missingIdempotencyKey(method, new URL(request.url()).pathname, headers)) {
      return problem(
        route,
        400,
        'idempotency-key-required',
        'Informe o cabeçalho Idempotency-Key com um UUID.',
      );
    }

    if (method === 'GET' && path === '/agent-alerts') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mock.alerts),
      });
    }

    if (method === 'POST' && path === '/agent-alerts/seen') {
      mock.alerts.length = 0;
      return route.fulfill({ status: 204 });
    }

    const oneSeen = method === 'POST' ? /^\/agent-alerts\/([^/]+)\/seen$/.exec(path) : null;
    if (oneSeen) {
      const index = mock.alerts.findIndex((alert) => alert.id === oneSeen[1]);
      if (index >= 0) mock.alerts.splice(index, 1);
      return route.fulfill({ status: 204 });
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
          action: 'tv.bind-agent',
        });
      }
      if (!mock.openCodes.has(code))
        return problem(route, 404, 'pairing-not-found', 'Não encontrado.');
      mock.openCodes.delete(code);
      identity.stepUpValid = false;
      const name = (body?.['name'] as string | null) ?? 'Agente';
      const agent: StoredAgent = storedAgent({
        id: `00000000-0000-4000-8000-00000000000${mock.agents.length + 1}`,
        slug: `agent:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        lastSeenAt: null,
        connected: false,
        agentVersion: null,
        agentBuild: null,
        os: null,
        tvKind: null,
        tvHost: null,
        canReadLogs: false,
        canMaintain: false,
        update: null,
      });
      mock.agents.push(agent);
      // Como a API: a lista de pessoas (mesmo vazia) cria, na mesma aprovação, a TV ligada ao novo agente.
      const members = body?.['tvMemberIds'];
      if (Array.isArray(members)) {
        mock.tvs.push({
          name: (body?.['tvName'] as string | null) ?? agent.name,
          agentSlug: agent.slug,
          memberIds: members as string[],
        });
      }
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

    // O convidado com a TV aprova o PC dele como a própria TV: a senha reconfirmada, uma TV só dele, nunca a padrão e
    // um teto de computadores ativos (a API real confere o resto: permissão da TV e o corpo sem lista de pessoas).
    if (method === 'POST' && path === '/pairing/approve-own') {
      const guest = identity.role === 'guest' ? identity.guests.at(-1) : undefined;
      if (!guest) return problem(route, 403, 'forbidden', 'Só para convidados.');
      if (!identity.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a senha.', {
          code: 'step_up_required',
          action: 'devices.pair-self',
        });
      }
      const code = String(body?.['userCode'] ?? '');
      if (mock.agents.filter((a) => !a.revoked).length >= mock.guestLimit) {
        return problem(route, 409, 'guest-agent-limit', 'Limite de computadores.');
      }
      if (!mock.openCodes.has(code))
        return problem(route, 404, 'pairing-not-found', 'Não encontrado.');
      mock.openCodes.delete(code);
      identity.stepUpValid = false;
      const agent: StoredAgent = {
        id: `00000000-0000-4000-8000-00000000000${mock.agents.length + 1}`,
        slug: `agent:pc-${mock.agents.length + 1}`,
        name: 'PC do convidado',
        platform: 'windows',
        createdAt: '2026-10-18T12:00:00Z',
        revoked: false,
        lastSeenAt: null,
      };
      mock.agents.push(agent);
      mock.tvs.push({
        name: (body?.['tvName'] as string | null) ?? agent.name,
        agentSlug: agent.slug,
        memberIds: [guest.id],
      });
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

    // Só o dono chega aqui (o convidado leva 403 antes): o registro e a manutenção de um agente.
    const logs = /^\/agents\/([^/]+)\/logs$/.exec(path);
    if (method === 'POST' && logs) {
      const agent = mock.agents.find((a) => a.id === logs[1] && !a.revoked);
      if (!agent) return route.fulfill({ status: 404 });
      if (!agent.connected)
        return problem(route, 503, 'agent-offline', 'O agente não está conectado.');
      if (!agent.canReadLogs) {
        return problem(route, 409, 'agent-outdated', 'O agente precisa ser atualizado para isto.');
      }
      if (mock.log.problem) {
        return problem(route, mock.log.problem.status, mock.log.problem.kind, 'Falhou.');
      }
      const text = mock.log.text ?? '';
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({
          text,
          lines: text === '' ? 0 : text.split('\n').length,
          truncated: mock.log.truncated ?? false,
          at: '2026-10-24T14:02:00Z',
        }),
      });
    }

    const maintenance = /^\/agents\/([^/]+)\/maintenance$/.exec(path);
    if (method === 'POST' && maintenance) {
      // Como a API: a confirmação vem antes de tudo, e vale por alguns minutos (não é gasta por uma ação).
      if (!identity.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'devices.agent-maintenance',
        });
      }
      const agent = mock.agents.find((a) => a.id === maintenance[1] && !a.revoked);
      if (!agent) return route.fulfill({ status: 404 });
      const action = body?.['action'];
      if (action !== 'update' && action !== 'restart' && action !== 'rollback') {
        return problem(route, 400, 'validation', 'Escolha update, restart ou rollback.');
      }
      if (action === 'rollback' && !agent.canRollback) {
        return problem(route, 409, 'no-previous-version', 'Sem versão anterior.');
      }
      if (mock.maintenanceProblem) {
        return problem(
          route,
          mock.maintenanceProblem.status,
          mock.maintenanceProblem.kind,
          'Falhou.',
        );
      }
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, accepted: true }),
      });
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
