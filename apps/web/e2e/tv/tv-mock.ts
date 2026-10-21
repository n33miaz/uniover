import { BrowserContext, Page, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

export interface TvRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
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

export interface MockTvState {
  power: string;
  volume: number | null;
  app: string | null;
  connection: string;
  agentOnline: boolean;
  updatedAt: string | null;
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
  state: MockTvState;
  shortcuts: MockShortcut[];
  /** Falha de `/keys`, `/text`, `/power/off`, `/launch` e `/refresh` (não de `/wake`). */
  commandFailure: MockFailure | null;
  /** Falha de `/wake`. */
  wakeFailure: MockFailure | null;
  /** Falha de `PUT /shortcuts/order` (a ordem dos atalhos); nada é gravado enquanto ela estiver aqui. */
  orderFailure: MockFailure | null;
  /** Enquanto houver uma promessa aqui, `PUT /shortcuts/order` espera por ela (para ver a ordem antes de o servidor responder). */
  orderGate: Promise<void> | null;
  /** Enquanto houver uma promessa aqui, `GET /state` espera por ela (para ver a tela "conectando"). */
  stateGate: Promise<void> | null;
  /** Pedidos de comando por rota (`/keys`, `/power/off`, ...). */
  count(path: string): number;
  keysSent(): string[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

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
 * precisa de `Content-Type: application/json` (senão a API real responde 415) e desligar não pede passkey, então
 * o mock nunca responde 403.
 */
export async function mockTvApi(context: BrowserContext, identity: IdentityMock): Promise<TvMock> {
  const mock: TvMock = {
    requests: [],
    state: { ...HOT_STATE },
    shortcuts: SHORTCUTS.map((s) => ({ ...s })),
    commandFailure: null,
    wakeFailure: null,
    orderFailure: null,
    orderGate: null,
    stateGate: null,
    count: (path) => mock.requests.filter((r) => r.method === 'POST' && r.path === path).length,
    keysSent: () =>
      mock.requests.filter((r) => r.path === '/keys').map((r) => String(r.body?.['key'])),
  };

  await context.route('**/api/v1/tv/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/tv', '');
    const method = request.method();
    const headers = request.headers();
    const isJson = (headers['content-type'] ?? '').startsWith('application/json');
    const body = isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null;
    mock.requests.push({ method, path, body });

    if (identity.offline) return route.abort('internetdisconnected');
    if (request.postData() && !isJson) {
      return problem(route, { status: 415, kind: 'unsupported-media-type' });
    }

    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, { status: 401, kind: 'unauthenticated' });
    }

    if (method === 'GET' && path === '/state') {
      if (mock.stateGate) await mock.stateGate;
      return json(route, 200, mock.state);
    }
    if (method === 'GET' && path === '/shortcuts') return json(route, 200, mock.shortcuts);

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

    // Como a API: só o dono muda a ordem (o mock não tem convidado), e a lista tem de ser uma permutação exata dos atalhos.
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
    if (method === 'POST' && (path === '/text' || path === '/power/off')) {
      return json(route, 200, { ok: true, latencyMs: 40 });
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
