import { BrowserContext, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

export interface LivreRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly contentType: string | null;
  /** Os bytes do corpo, quando não é JSON (a foto). */
  readonly bytes: Buffer | null;
}

/** Uma falha que a rota dada devolve (e que se repete até o teste limpar), como a API a devolveria. */
export interface LivreFailure {
  readonly status: number;
  readonly kind: string;
  readonly agentError?: string;
}

export interface LivreMock {
  readonly requests: LivreRequest[];
  /** O `TvLivreView` do servidor de mentira; o teste muda os campos antes de abrir a tela. */
  view: Record<string, unknown>;
  /** Falha por rota (`/install`, `/apply`...). */
  failures: Record<string, LivreFailure>;
  photo: Buffer | null;
  /** Os pedidos de uma rota, na ordem em que chegaram. */
  to(method: string, path: string): LivreRequest[];
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

export const LIVRE_CONFIG = {
  clock: { enabled: true, size: 'large', format: '24h', seconds: false, date: true },
  wallpaper: { type: 'gradient', colors: ['#1B2440', '#3A2D5C'], angle: 315, dim: 0.25 },
  apps: { mode: 'all', items: [], hidden: [], showFactory: false },
  icons: { size: 'medium', labels: 'always' },
  builtin: { settings: true, sleep: false },
  sleep: { maxMinutes: 0 },
};

/** O estado de uma TV compatível ainda sem o TV Livre: três apps do usuário e dois de fábrica. */
export function livreView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    supported: true,
    installed: false,
    version: null,
    isHome: false,
    factoryLauncher: 'com.exemplo.fabrica.launcher',
    disabledPackages: [],
    apps: [
      { package: 'exemplo.pacote.app1', factory: false, disabled: false },
      { package: 'exemplo.pacote.app2', factory: false, disabled: false },
      { package: 'exemplo.pacote.app3', factory: false, disabled: false },
      { package: 'com.exemplo.cinema', factory: false, disabled: false },
      { package: 'com.exemplo.fabrica.player', factory: true, disabled: false },
      { package: 'com.exemplo.fabrica.musica', factory: true, disabled: false },
    ],
    stateAt: '2026-10-31T12:00:00Z',
    config: structuredClone(LIVRE_CONFIG),
    hasPhoto: false,
    revision: 0,
    ...overrides,
  };
}

function problem(route: Route, failure: LivreFailure) {
  return route.fulfill({
    status: failure.status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: PROBLEM_BASE + failure.kind,
      title: failure.kind,
      status: failure.status,
      ...(failure.agentError ? { agentError: failure.agentError } : {}),
    }),
  });
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A API do TV Livre de mentira (`/api/v1/tv/livre/...`), no formato do contrato: só o dono, login obrigatório, e a foto
 * recusada como a real (só `image/jpeg`, começando por `FF D8 FF`, até 400 KiB). Registre DEPOIS de `mockTvApi`: o
 * Playwright atende primeiro a rota registrada por último, e o mock da TV responde 404 a tudo que não conhece.
 */
export async function mockLivreApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<LivreMock> {
  const mock: LivreMock = {
    requests: [],
    view: livreView(),
    failures: {},
    photo: null,
    to: (method, path) =>
      mock.requests.filter((request) => request.method === method && request.path === path),
  };

  await context.route(/\/api\/v1\/tv\/livre(\/|\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/tv/livre', '') || '/';
    const method = request.method();
    const contentType = request.headers()['content-type'] ?? null;
    const isJson = (contentType ?? '').startsWith('application/json');
    mock.requests.push({
      method,
      path,
      body: isJson ? (request.postDataJSON() as Record<string, unknown> | null) : null,
      contentType,
      bytes: isJson ? null : request.postDataBuffer(),
    });

    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = request.headers()['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, { status: 401, kind: 'unauthenticated' });
    }
    if (identity.role !== 'owner') return problem(route, { status: 403, kind: 'forbidden' });

    const failure = mock.failures[path];
    if (failure) return problem(route, failure);

    const view = mock.view;
    if (method === 'GET' && path === '/') return json(route, view);
    if (method === 'POST' && path === '/refresh') return json(route, view);
    if (method === 'PUT' && path === '/config') {
      view['config'] = request.postDataJSON();
      return json(route, view);
    }
    if (method === 'POST' && path === '/apply') {
      view['revision'] = Number(view['revision']) + 1;
      return json(route, view);
    }
    if (method === 'POST' && path === '/install') {
      view['installed'] = true;
      view['version'] = '0.1.0';
      return json(route, view);
    }
    if (method === 'POST' && path === '/set-home') {
      view['isHome'] = true;
      return json(route, view);
    }
    if (method === 'POST' && path === '/restore') {
      view['installed'] = false;
      view['version'] = null;
      view['isHome'] = false;
      return json(route, view);
    }
    if (method === 'POST' && path === '/sleep') return route.fulfill({ status: 204 });
    if (path === '/photo') {
      if (method === 'PUT') {
        // O WebKit não entrega o corpo binário de um Blob ao Playwright: o tamanho vem do cabeçalho, e o conteúdo, quando
        // falta, é conferido na própria página (ver o teste da foto).
        const bytes = request.postDataBuffer();
        const length = Number(request.headers()['content-length'] ?? bytes?.length ?? 0);
        if (!contentType?.startsWith('image/jpeg')) {
          return problem(route, { status: 415, kind: 'unsupported-media-type' });
        }
        if (length > 409_600) return problem(route, { status: 413, kind: 'payload-too-large' });
        if (bytes && (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)) {
          return problem(route, { status: 415, kind: 'unsupported-media-type' });
        }
        mock.photo = bytes ?? Buffer.alloc(0);
        view['hasPhoto'] = true;
        return route.fulfill({ status: 204 });
      }
      if (method === 'GET') {
        return mock.photo
          ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: mock.photo })
          : route.fulfill({ status: 404 });
      }
      if (method === 'DELETE') {
        mock.photo = null;
        view['hasPhoto'] = false;
        return route.fulfill({ status: 204 });
      }
    }
    return route.fulfill({ status: 404 });
  });

  return mock;
}

/** Largura e altura de um JPEG, lidas do primeiro quadro (`SOF`); `null` se não achar. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}
