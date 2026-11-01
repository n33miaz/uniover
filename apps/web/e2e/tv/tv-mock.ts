import { BrowserContext, Page, Route } from '@playwright/test';
import { ALL_PERMISSIONS, IdentityMock } from '../auth/identity-mock';

export interface TvRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  /** O `?tvId=` do pedido (`null` quando o app não o mandou). */
  readonly tvId: string | null;
}

/**
 * Uma TV do servidor de mentira (várias TVs). `state` e `shortcuts` são os dela; sem eles valem os do mock inteiro, o que
 * mantém todos os cenários de uma TV só como eram. `agentSlug` só chega ao administrador, como na API.
 */
export interface MockTv {
  id: string;
  name: string;
  isDefault: boolean;
  agentSlug: string | null;
  kind: 'android' | 'samsung' | null;
  online: boolean;
  capabilities: string[];
  /** Fechar apps em segundo plano na limpeza desta TV; ausente vale desligado, como na API. */
  allowBackgroundAppClosing?: boolean;
  /** Modo Foco e o fechamento dos outros apps nele; ausentes valem desligado, como na API. */
  focusModeEnabled?: boolean;
  focusClosesBackground?: boolean;
  /** Manutenção automática (Samsung); ausente vale ligada, como na API. */
  autoMaintenanceEnabled?: boolean;
  /** A TV Samsung esqueceu o UniOver e espera alguém escolher "Permitir" nela; ausente vale que não. */
  permissionNeeded?: boolean;
  /** As últimas limpezas, como `GET /tvs/{id}/cleanup-reports` devolve. */
  cleanupReports?: Record<string, unknown>[];
  state?: MockTvState;
  shortcuts?: MockShortcut[];
}

export interface MockShortcut {
  id: string;
  position: number;
  package: string;
  tvLabel: string | null;
  customLabel: string | null;
  /** No controle (a fileira de atalhos): escolhido pelo dono e instalado. */
  enabled: boolean;
  /** O app está na TV. Só isso decide se ele abre: um app instalado e fora do controle também abre. */
  installed: boolean;
  /** Ausente nos atalhos antigos (o mock não preenche): a tela trata como "sem ícone". */
  iconDataUri?: string | null;
}

/** O que a limpeza da TV devolve: o relatório do agente (memória em MB, `null` quando não deu para ler). */
export interface MockCleanup {
  ok: true;
  latencyMs: number;
  closedApps: number;
  freedMb: number | null;
  memoryBeforeMb: number | null;
  memoryAfterMb: number | null;
  failedSteps: string[];
}

export interface MockTvState {
  power: string;
  volume: number | null;
  app: string | null;
  connection: string;
  agentOnline: boolean;
  /** A TV da conta tem agente vinculado (ausente vale sim, como na API antiga). */
  agentLinked?: boolean;
  updatedAt: string | null;
  /** Desde quando o agente está fora (a API só manda com ele fora): é o que confirma o "PC Desligado". */
  offlineSince?: string | null;
}

/** Falha que a próxima chamada de comando devolve (e que se repete até o teste limpar). */
export interface MockFailure {
  readonly status: number;
  readonly kind: string;
  readonly extra?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

export interface TvMock {
  readonly requests: TvRequest[];
  powerSchedule: { active: Record<string, unknown> | null; last: Record<string, unknown> | null };
  /**
   * Os pedidos que a API real recusaria com 403 por falta de permissão (o mock os recusa do mesmo jeito). A tela que
   * esconde o que a pessoa não pode nunca os faz: os testes de permissão afirmam que esta lista fica vazia.
   */
  readonly denied: TvRequest[];
  state: MockTvState;
  shortcuts: MockShortcut[];
  /**
   * As TVs do servidor. `null` (o padrão) é um servidor sem várias TVs: `GET /tvs` responde 404 e o app se comporta como
   * sempre. Com a lista, cada conta vê as que a regra de visibilidade da API manda (ver `visibleTvs`).
   */
  tvs: MockTv[] | null;
  /** As contas de cada TV (`tvId` para os ids das contas), como `GET/PUT /tvs/{id}/members`. */
  members: Record<string, string[]>;
  layouts: Record<string, Record<string, unknown>>;
  /** Enquanto houver uma promessa aqui, `GET /shortcuts` espera por ela (para ver a TV nova ainda sem atalhos). */
  shortcutsGate: Promise<void> | null;
  /** Falha de `/keys`, `/text`, `/power/off`, `/launch`, `/refresh` e `/cleanup` (não de `/wake`). */
  commandFailure: MockFailure | null;
  /** Falha de `/wake`. */
  wakeFailure: MockFailure | null;
  /** Falha de `PUT /shortcuts/order` (a ordem dos atalhos); nada é gravado enquanto ela estiver aqui. */
  orderFailure: MockFailure | null;
  /** Enquanto houver uma promessa aqui, `PUT /shortcuts/order` espera por ela (para ver a ordem antes de o servidor responder). */
  orderGate: Promise<void> | null;
  /** Enquanto houver uma promessa aqui, `GET /state` espera por ela (para ver a tela "conectando"). */
  stateGate: Promise<void> | null;
  /** O que `POST /cleanup` responde quando dá certo. */
  cleanupResult: MockCleanup;
  /** Enquanto houver uma promessa aqui, `POST /cleanup` espera por ela (para ver o "Limpando…"). */
  cleanupGate: Promise<void> | null;
  /**
   * O que `POST /power/off` responde ao pedido com leitura (`{ "mode": "safe" }`) quando dá certo: o desligamento
   * confirmado ou a TV que já estava desligada. O pedido sem corpo, de antes, responde `sent`.
   */
  powerOffOutcome: 'off' | 'already_off';
  /** As TVs que cada computador achou na rede dele, como `GET /tvs/nearby?agent=` devolve (sem entrada: lista vazia). */
  nearby: Record<string, { status: string; items: Record<string, unknown>[] }>;
  /** Enquanto houver uma promessa aqui, `GET /tvs/nearby` espera por ela (para ver o "Procurando TVs…"). */
  nearbyGate: Promise<void> | null;
  /**
   * O que `POST /permission/request` responde: `asked` (o aviso foi para a TV e, com `grantOnAsk`, o aceite já vale),
   * `unreachable` (a TV não respondeu), `unsupported` (computador antigo) ou `busy` (o aviso já está na TV).
   */
  permissionAnswer: 'asked' | 'unreachable' | 'unsupported' | 'busy';
  /** Com `asked`, a TV passa a reconhecer o UniOver na hora (a pessoa aceitou). */
  grantOnAsk: boolean;
  /** Pedidos de comando por rota (`/keys`, `/power/off`, ...). */
  count(path: string): number;
  /** O `mode` de cada `POST /power/off` recebido (`null` é o pedido de antes, sem corpo). */
  powerOffModes(): (string | null)[];
  keysSent(): string[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

/**
 * A permissão que cada rota da API exige (a política por rota): ver a TV, controlar, desligar, abrir apps, editar os
 * atalhos e ler o histórico. `null` é uma rota que o mock não conhece (cai no 404 de sempre).
 */
function requiredPermission(method: string, path: string): string | null {
  if (
    method === 'GET' &&
    (path === '/state' || path === '/shortcuts' || path === '/tvs' || path === '/layout')
  ) {
    return 'module:tv';
  }
  if (method === 'GET' && path === '/permission') return 'module:tv';
  if (method === 'POST' && path === '/permission/request') return 'tv:control';
  if (method === 'GET' && path === '/commands/recent') return 'tv:history';
  if (method === 'GET' && path === '/cleanup/latest') return 'tv:control';
  if (method === 'POST' && ['/wake', '/keys', '/text', '/cleanup'].includes(path))
    return 'tv:control';
  if (method === 'POST' && path === '/power/off') return 'tv:power';
  if (path === '/power/schedule' && ['GET', 'PUT', 'DELETE'].includes(method)) return 'tv:power';
  if (
    method === 'POST' &&
    (path === '/shortcuts/refresh' || /^\/shortcuts\/[^/]+\/launch$/.test(path))
  ) {
    return 'tv:launch';
  }
  if (method === 'PATCH' && /^\/shortcuts\/[^/]+$/.test(path)) return 'tv:edit-shortcuts';
  if (method === 'PUT' && path === '/shortcuts/order') return 'tv:edit-shortcuts';
  return null;
}

/**
 * O que a conta da sessão aberta pode fazer, pela mesma regra de `GET /me` no mock de identidade (os dois não podem
 * divergir): o dono tudo; a convidada a lista dela, ou `guestPermissions`; sem linha de convidada, tudo.
 */
function permissionsOf(identity: IdentityMock): readonly string[] {
  const guest = identity.role === 'guest' ? identity.guests.at(-1) : undefined;
  return guest ? (guest.permissions ?? identity.guestPermissions) : ALL_PERMISSIONS;
}

/** O id da conta da sessão aberta no simulador de identidade. */
function accountOf(identity: IdentityMock): string | null {
  return (identity.role === 'guest' ? identity.guests.at(-1)?.id : undefined) ?? null;
}

/**
 * As TVs que a conta vê (a regra da API): o administrador, todas; as demais, as de que são membros; quem não é membro de
 * nenhuma continua vendo a padrão. A lista sai com a padrão na frente e depois por nome, como a API a ordena.
 */
function visibleTvs(mock: TvMock, identity: IdentityMock): MockTv[] {
  if (!mock.tvs) return [];
  const all = [...mock.tvs].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
  );
  if (identity.role === 'owner') return all;
  const me = accountOf(identity);
  const own = all.filter((tv) => me !== null && (mock.members[tv.id] ?? []).includes(me));
  return own.length > 0 ? own : all.filter((tv) => tv.isDefault);
}

export const HOT_STATE: MockTvState = {
  power: 'on',
  volume: 22,
  app: null,
  connection: 'hot',
  agentOnline: true,
  updatedAt: '2026-10-19T14:02:00Z',
};

export const SHORTCUTS: MockShortcut[] = [1, 2, 3].map((position) => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  position,
  package: `exemplo.pacote.app${position}`,
  tvLabel: null,
  customLabel: null,
  enabled: true,
  installed: true,
}));

function problem(route: Route, failure: MockFailure) {
  return route.fulfill({
    status: failure.status,
    headers: { 'content-type': 'application/problem+json', ...failure.headers },
    body: JSON.stringify({
      type: PROBLEM_BASE + failure.kind,
      title: failure.kind,
      status: failure.status,
      ...failure.extra,
    }),
  });
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Simula a API da TV no formato da real: login obrigatório, `POWER` recusado em `/keys` (400), todo POST com corpo
 * precisa de `Content-Type: application/json` (senão a API real responde 415) e desligar não pede passkey. Cada rota
 * confere a permissão da conta da sessão aberta, como a política por rota da API: o dono pode tudo, a convidada o que a
 * lista dela traz (e toda ação da TV exige ver a TV); o que falta é recusado com 403 e registrado em `denied`.
 */
export async function mockTvApi(context: BrowserContext, identity: IdentityMock): Promise<TvMock> {
  const mock: TvMock = {
    requests: [],
    denied: [],
    state: { ...HOT_STATE },
    shortcuts: SHORTCUTS.map((s) => ({ ...s })),
    tvs: null,
    members: {},
    layouts: {},
    powerSchedule: { active: null, last: null },
    shortcutsGate: null,
    commandFailure: null,
    wakeFailure: null,
    orderFailure: null,
    orderGate: null,
    stateGate: null,
    cleanupResult: {
      ok: true,
      latencyMs: 9000,
      closedApps: 6,
      freedMb: 383,
      memoryBeforeMb: 214,
      memoryAfterMb: 597,
      failedSteps: [],
    },
    cleanupGate: null,
    powerOffOutcome: 'off',
    nearby: {},
    nearbyGate: null,
    permissionAnswer: 'asked',
    grantOnAsk: true,
    powerOffModes: () =>
      mock.requests
        .filter((r) => r.method === 'POST' && r.path === '/power/off')
        .map((r) => (typeof r.body?.['mode'] === 'string' ? r.body['mode'] : null)),
    count: (path) => mock.requests.filter((r) => r.method === 'POST' && r.path === path).length,
    keysSent: () =>
      mock.requests.filter((r) => r.path === '/keys').map((r) => String(r.body?.['key'])),
  };

  await context.route('**/api/v1/tv/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/tv', '');
    const tvId = url.searchParams.get('tvId');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    mock.requests.push({ method, path, body, tvId });

    if (identity.offline) return route.abort('internetdisconnected');
    if (request.postData() && !isJson) {
      return problem(route, { status: 415, kind: 'unsupported-media-type' });
    }

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, { status: 401, kind: 'unauthenticated' });
    }

    // A política de cada rota: a permissão da rota, e toda ação da TV exige também ver a TV (como na API).
    const needed = requiredPermission(method, path);
    if (needed) {
      const granted = permissionsOf(identity);
      if (!granted.includes(needed) || (needed !== 'module:tv' && !granted.includes('module:tv'))) {
        mock.denied.push({ method, path, body, tvId });
        return problem(route, { status: 403, kind: 'forbidden' });
      }
    }

    // Várias TVs: a lista, a administração (só do dono, com a passkey) e a escolha de qual TV responde cada pedido.
    if (mock.tvs) {
      const handled = await handleTvs(route, mock, identity, { method, path, body, tvId });
      if (handled) return;
    }
    // Sem `tvId` a API usa a única visível (ou a padrão, ou a primeira por nome); com ele, a pedida.
    const chosen = !mock.tvs
      ? null
      : tvId
        ? (mock.tvs.find((tv) => tv.id === tvId) ?? null)
        : (visibleTvs(mock, identity)[0] ?? null);
    if (mock.tvs && tvId && !visibleTvs(mock, identity).some((tv) => tv.id === tvId)) {
      return problem(route, { status: 404, kind: 'not-found' });
    }

    if (path === '/layout' && chosen) {
      if (method === 'GET') {
        const layout = mock.layouts[chosen.id];
        return layout ? json(route, 200, layout) : route.fulfill({ status: 204 });
      }
      if (identity.role !== 'owner') return problem(route, { status: 403, kind: 'forbidden' });
      if (method === 'POST' && mock.layouts[chosen.id])
        return problem(route, { status: 409, kind: 'conflict' });
      if (method === 'POST' || method === 'PUT') {
        mock.layouts[chosen.id] = body ?? {};
        return json(route, 200, body);
      }
    }

    // As TVs da conta que esperam o aceite: o administrador só as que usa (a padrão); as demais, as de que são membros.
    if (method === 'GET' && path === '/permission' && mock.tvs) {
      const me = accountOf(identity);
      const items = visibleTvs(mock, identity)
        .filter(
          (tv) =>
            tv.permissionNeeded === true &&
            (identity.role === 'owner'
              ? tv.isDefault
              : (mock.members[tv.id] ?? []).includes(me ?? '')),
        )
        .map((tv) => ({ tvId: tv.id, name: tv.name }));
      return json(route, 200, { items });
    }
    if (method === 'POST' && path === '/permission/request' && chosen) {
      if (mock.permissionAnswer === 'unsupported') {
        return problem(route, { status: 409, kind: 'permission-unsupported' });
      }
      if (mock.permissionAnswer === 'unreachable') {
        return problem(route, {
          status: 502,
          kind: 'command-failed',
          extra: { agentError: 'tv_unreachable' },
        });
      }
      if (mock.permissionAnswer === 'busy') {
        return problem(route, {
          status: 502,
          kind: 'command-failed',
          extra: { agentError: 'permission_in_progress' },
        });
      }
      if (mock.grantOnAsk) chosen.permissionNeeded = false;
      return json(route, 200, { ok: true, latencyMs: 40 });
    }

    if (method === 'GET' && path === '/state') {
      if (mock.stateGate) await mock.stateGate;
      return json(route, 200, chosen?.state ?? mock.state);
    }
    if (method === 'GET' && path === '/shortcuts') {
      if (mock.shortcutsGate) await mock.shortcutsGate;
      return json(route, 200, chosen?.shortcuts ?? mock.shortcuts);
    }

    if (path === '/power/schedule') {
      if (method === 'GET') return json(route, 200, mock.powerSchedule);
      if (method === 'PUT') {
        const version = mock.powerSchedule.active?.['version'];
        if ((version ?? null) !== (body?.['version'] ?? null))
          return problem(route, { status: 409, kind: 'conflict' });
        const active = {
          id: 'agendamento',
          dueAtUtc: body?.['dueAtUtc'],
          timeZone: body?.['timeZone'],
          status: 'pending',
          result: null,
          reason: null,
          version: typeof version === 'number' ? version + 1 : 1,
        };
        mock.powerSchedule.active = active;
        return json(route, 200, active);
      }
      if (method === 'DELETE') {
        if (url.searchParams.get('version') !== String(mock.powerSchedule.active?.['version']))
          return problem(route, { status: 409, kind: 'conflict' });
        mock.powerSchedule.active = null;
        return route.fulfill({ status: 204 });
      }
    }

    if (method === 'POST' && path === '/wake') {
      if (mock.wakeFailure) return problem(route, mock.wakeFailure);
      return route.fulfill({ status: 202 });
    }

    if (method === 'PATCH' && /^\/shortcuts\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      const found = mock.shortcuts.find((s) => s.id === id);
      if (!found) return problem(route, { status: 404, kind: 'not-found' });
      if (typeof body?.['customLabel'] === 'string') {
        found.customLabel = body['customLabel'].trim() || null;
      }
      if (typeof body?.['enabled'] === 'boolean') found.enabled = body['enabled'];
      return json(route, 200, found);
    }

    // Como a API: a lista tem de ser uma permutação exata dos atalhos (a permissão de editar já foi conferida acima).
    if (method === 'PUT' && path === '/shortcuts/order') {
      if (mock.orderGate) await mock.orderGate;
      if (mock.orderFailure) return problem(route, mock.orderFailure);
      const ids = Array.isArray(body?.['ids']) ? (body['ids'] as string[]) : null;
      const known = new Set(mock.shortcuts.map((s) => s.id));
      if (
        !ids ||
        ids.length !== known.size ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !known.has(id))
      ) {
        return problem(route, { status: 400, kind: 'validation-failed' });
      }
      // Posições de 1 a n na ordem pedida, como a API; a lista guardada passa a ser essa (recarregar a tela a mantém).
      mock.shortcuts = ids.map((id, index) => ({
        ...mock.shortcuts.find((s) => s.id === id)!,
        position: index + 1,
      }));
      return json(route, 200, mock.shortcuts);
    }

    // Daqui para baixo são comandos para a TV.
    if (mock.commandFailure) return problem(route, mock.commandFailure);

    if (method === 'POST' && path === '/keys') {
      if (body?.['key'] === 'POWER')
        return problem(route, { status: 400, kind: 'validation-failed' });
      return json(route, 200, { ok: true, latencyMs: 40 });
    }
    if (method === 'POST' && path === '/power/off') {
      return json(route, 200, {
        ok: true,
        latencyMs: 40,
        outcome: body?.['mode'] === 'safe' ? mock.powerOffOutcome : 'sent',
      });
    }
    if (method === 'POST' && path === '/text') {
      return json(route, 200, { ok: true, latencyMs: 40 });
    }
    if (method === 'POST' && path === '/cleanup') {
      if (mock.cleanupGate) await mock.cleanupGate;
      return json(route, 200, mock.cleanupResult);
    }
    if (method === 'GET' && path === '/cleanup/latest') {
      // Sem limpeza gravada a API responde 204, e a tela não mostra nada.
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/shortcuts/refresh') {
      return json(route, 200, { ok: true, latencyMs: 40 });
    }
    const launch = /^\/shortcuts\/([^/]+)\/launch$/.exec(path);
    if (method === 'POST' && launch) {
      const found = mock.shortcuts.find((s) => s.id === launch[1]);
      if (!found) return problem(route, { status: 404, kind: 'not-found' });
      // Como a API: só o app que saiu da TV é recusado; estar fora do controle não impede de abrir.
      if (!found.installed) return problem(route, { status: 409, kind: 'shortcut-disabled' });
      return json(route, 200, { ok: true, latencyMs: 40 });
    }

    return route.fulfill({ status: 404 });
  });

  return mock;
}

/**
 * As rotas de várias TVs. Devolve `true` quando respondeu. Escrever é do administrador e pede a confirmação com a passkey
 * (`identity.stepUpValid`, que a API deixa valer alguns minutos para a ação), como o `PUT /config/agent`; criar com um computador que já tem TV é 409.
 */
async function handleTvs(
  route: Route,
  mock: TvMock,
  identity: IdentityMock,
  request: TvRequest,
): Promise<boolean> {
  const { method, path, body } = request;
  const tvs = mock.tvs!;
  const owner = identity.role === 'owner';

  if (method === 'GET' && path === '/tvs') {
    const items = visibleTvs(mock, identity).map((tv) => ({
      id: tv.id,
      name: tv.name,
      isDefault: tv.isDefault,
      ...(owner ? { agentSlug: tv.agentSlug } : {}),
      kind: tv.kind,
      online: tv.online,
      capabilities: tv.capabilities,
      allowBackgroundAppClosing: tv.allowBackgroundAppClosing ?? false,
      permissionNeeded: tv.permissionNeeded ?? false,
    }));
    await json(route, 200, { items });
    return true;
  }

  // As TVs que o computador achou na rede dele (só o administrador; leva uns segundos de verdade).
  if (method === 'GET' && path === '/tvs/nearby') {
    if (!owner) {
      await problem(route, { status: 403, kind: 'forbidden' });
      return true;
    }
    if (mock.nearbyGate) await mock.nearbyGate;
    const agent = new URL(route.request().url()).searchParams.get('agent') ?? '';
    await json(route, 200, mock.nearby[agent] ?? { status: 'ok', items: [] });
    return true;
  }

  const target = /^\/tvs(?:\/([^/]+)(\/members|\/cleanup-reports|\/apps)?)?$/.exec(path);
  if (!target) return false;
  if (!owner) {
    await problem(route, { status: 403, kind: 'forbidden' });
    return true;
  }
  const writes = method !== 'GET';
  if (writes && !identity.stepUpValid) {
    await problem(route, {
      status: 403,
      kind: 'step-up-required',
      extra: { code: 'step_up_required', action: 'tv.bind-agent' },
    });
    return true;
  }
  const summary = (tv: MockTv) => ({
    id: tv.id,
    name: tv.name,
    isDefault: tv.isDefault,
    agentSlug: tv.agentSlug,
    kind: tv.kind,
    online: tv.online,
    capabilities: tv.capabilities,
    allowBackgroundAppClosing: tv.allowBackgroundAppClosing ?? false,
    focusModeEnabled: tv.focusModeEnabled ?? false,
    focusClosesBackground: tv.focusClosesBackground ?? false,
    autoMaintenanceEnabled: tv.autoMaintenanceEnabled ?? true,
    permissionNeeded: tv.permissionNeeded ?? false,
  });
  const found = target[1] ? tvs.find((tv) => tv.id === target[1]) : undefined;

  if (!target[1] && method === 'POST') {
    const agentSlug = String(body?.['agentSlug'] ?? '');
    const name = String(body?.['name'] ?? '').trim();
    if (!agentSlug || !name) {
      await problem(route, { status: 400, kind: 'validation-failed' });
      return true;
    }
    if (tvs.some((tv) => tv.agentSlug === agentSlug)) {
      await problem(route, { status: 409, kind: 'agent-in-use' });
      return true;
    }
    const created: MockTv = {
      id: `tv-${tvs.length + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      isDefault: false,
      agentSlug,
      kind: null,
      online: false,
      capabilities: [],
    };
    tvs.push(created);
    await json(route, 200, summary(created));
    return true;
  }

  if (!found) {
    await problem(route, { status: 404, kind: 'not-found' });
    return true;
  }

  if (!target[2] && method === 'PATCH') {
    const slug = body?.['agentSlug'];
    if (typeof slug === 'string' && tvs.some((tv) => tv.id !== found.id && tv.agentSlug === slug)) {
      await problem(route, { status: 409, kind: 'agent-in-use' });
      return true;
    }
    if (typeof body?.['name'] === 'string') found.name = body['name'].trim();
    if (typeof slug === 'string') found.agentSlug = slug;
    if (typeof body?.['allowBackgroundAppClosing'] === 'boolean') {
      found.allowBackgroundAppClosing = body['allowBackgroundAppClosing'];
    }
    if (typeof body?.['focusModeEnabled'] === 'boolean') {
      found.focusModeEnabled = body['focusModeEnabled'];
    }
    if (typeof body?.['focusClosesBackground'] === 'boolean') {
      found.focusClosesBackground = body['focusClosesBackground'];
    }
    if (typeof body?.['autoMaintenanceEnabled'] === 'boolean') {
      found.autoMaintenanceEnabled = body['autoMaintenanceEnabled'];
    }
    await json(route, 200, summary(found));
    return true;
  }

  if (!target[2] && method === 'DELETE') {
    if (found.isDefault) {
      await problem(route, { status: 409, kind: 'default-tv' });
      return true;
    }
    mock.tvs = tvs.filter((tv) => tv.id !== found.id);
    delete mock.members[found.id];
    await route.fulfill({ status: 204 });
    return true;
  }

  if (target[2] === '/apps' && method === 'GET') {
    const items = (found.shortcuts ?? [])
      .filter((shortcut) => shortcut.installed)
      .map((shortcut) => ({
        package: shortcut.package,
        label: shortcut.customLabel ?? shortcut.tvLabel ?? shortcut.package,
      }));
    await json(route, 200, { items });
    return true;
  }

  if (target[2] === '/cleanup-reports' && method === 'GET') {
    await json(route, 200, { items: found.cleanupReports ?? [] });
    return true;
  }

  if (target[2] && method === 'GET') {
    await json(route, 200, { userIds: mock.members[found.id] ?? [] });
    return true;
  }

  if (target[2] && method === 'PUT') {
    const ids = Array.isArray(body?.['userIds']) ? (body['userIds'] as string[]) : [];
    mock.members[found.id] = [...ids];
    await json(route, 200, { userIds: mock.members[found.id] });
    return true;
  }

  return false;
}

/**
 * `EventSource` falso: o servidor de teste não fala SSE, então a página recebe um objeto que o teste comanda
 * (`emitSse`). O navegador de verdade só entra em cena para o que importa: o app abrir a conexão pelo caminho
 * certo (sem token na URL), reagir aos eventos nomeados e reabrir depois de um erro.
 */
export async function installFakeEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Fake extends EventTarget {
      url: string;
      closed: boolean;
    }
    const sources: Fake[] = [];
    class FakeEventSource extends EventTarget {
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 0;
      closed = false;
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      constructor(
        readonly url: string,
        readonly withCredentials = false,
      ) {
        super();
        sources.push(this);
        setTimeout(() => {
          if (this.closed) return;
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        }, 0);
      }
      close(): void {
        this.closed = true;
        this.readyState = 2;
      }
    }
    Object.assign(window, {
      EventSource: FakeEventSource,
      __sse: {
        sources,
        urls: () => sources.map((source) => source.url),
        open: () => sources.filter((source) => !source.closed).length,
        emit(type: string, data: unknown) {
          for (const source of sources) {
            if (!source.closed) {
              source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
            }
          }
        },
        fail() {
          for (const source of sources) {
            if (!source.closed) source.dispatchEvent(new Event('error'));
          }
        },
      },
    });
  });
}

/** Entrega um evento nomeado do fluxo (`tv.state`, `tv.shortcuts`, `tv.watchdog`) a todas as conexões abertas. */
export async function emitSse(page: Page, type: string, data: unknown): Promise<void> {
  await page.evaluate(
    ([name, payload]) =>
      (window as unknown as { __sse: { emit(t: string, d: unknown): void } }).__sse.emit(
        name as string,
        payload,
      ),
    [type, data] as const,
  );
}

export async function failSse(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __sse: { fail(): void } }).__sse.fail());
}

export async function sseUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __sse: { urls(): string[] } }).__sse.urls());
}

/** Quantas conexões do fluxo seguem abertas agora (as fechadas pelo app ficam de fora). */
export async function openStreams(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __sse: { open(): number } }).__sse.open());
}
