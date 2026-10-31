import { BrowserContext, Route } from '@playwright/test';
import { IdentityMock } from '../auth/identity-mock';

export interface SystemRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

export interface MockComputer {
  slug: string;
  name: string;
  platform: string;
  online: boolean;
  revoked: boolean;
}

/** Uma ocorrência que o agente contou sobre si, no formato de `GET /devices/agents/diagnostics`. */
export interface MockDiagnostic {
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  component: string | null;
  detail: string;
  count: number;
}

export interface SystemMock {
  readonly requests: SystemRequest[];
  readonly computers: MockComputer[];
  /** O computador que controla a TV agora (`null` = nenhum) e de onde vem a escolha. */
  current: string | null;
  source: 'saved' | 'environment' | 'none';
  /** Quantas leituras seguintes respondem 500 (para o estado de erro e o "Tentar de novo"). */
  failReads: number;
  settings: { key: string; value: string | number | boolean; source: 'app' | 'server' }[];
  /** Os erros dos agentes (lista vazia por padrão) e quantas leituras seguintes dessa lista respondem 500. */
  diagnostics: MockDiagnostic[];
  failDiagnostics: number;
  /** Se o servidor tem o bucket de fotos completo (a tela mostra o estado e trava o interruptor sem ele). */
  bucketConfigured: boolean;
}

const PROBLEM_BASE = 'https://uniover.app/problems/';

function problem(
  route: Route,
  status: number,
  kind: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title, status, ...extra }),
  });
}

/** O que a API devolve em `GET /tv/config`: o computador de agora, o estado dele e a lista dos pareados não revogados. */
function view(mock: SystemMock) {
  const known = mock.computers.find((c) => c.slug === mock.current) ?? null;
  const status = !mock.current
    ? 'unknown'
    : !known
      ? 'unknown'
      : known.revoked
        ? 'revoked'
        : known.online
          ? 'online'
          : 'offline';
  return {
    name: 'TV',
    agentSlug: mock.current,
    agentName: known?.name ?? null,
    source: mock.source,
    agentStatus: status,
    agents: mock.computers
      .filter((c) => !c.revoked)
      .map((c) => ({ slug: c.slug, name: c.name, platform: c.platform, online: c.online })),
  };
}

/**
 * Simula a configuração da TV no formato da API real: ler é só do administrador (token válido do mock de identidade) e
 * trocar o computador exige a confirmação com a passkey (lida do estado do mock de identidade e gasta ao trocar). Só
 * aceita um computador pareado e não revogado, com a mesma recusa para qualquer outro.
 */
export async function mockSystemApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<SystemMock> {
  const mock: SystemMock = {
    requests: [],
    computers: [],
    current: null,
    source: 'none',
    failReads: 0,
    diagnostics: [],
    failDiagnostics: 0,
    bucketConfigured: true,
    settings: [
      { key: 'training.off-contact', value: 'foods@example.test', source: 'server' },
      { key: 'devices.max-per-guest', value: 2, source: 'server' },
      { key: 'devices.agent-offline-minutes', value: 10, source: 'server' },
      { key: 'training.photo-storage-enabled', value: false, source: 'server' },
      { key: 'tv.light-cleanup-enabled', value: true, source: 'server' },
      { key: 'tv.deep-cleanup-enabled', value: true, source: 'server' },
      { key: 'tv.deep-cleanup-memory-threshold-mb', value: 160, source: 'server' },
    ],
  };

  await context.route('**/api/v1/identity/system-settings**', async (route) => {
    const request = route.request();
    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = request.headers()['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer))
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    if (identity.role !== 'owner') return route.fulfill({ status: 403 });
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/photo-bucket'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: mock.bucketConfigured }),
      });
    if (request.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.settings),
      });
    if (request.method() !== 'PUT') return route.fulfill({ status: 404 });
    if (!identity.stepUpValid)
      return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
        code: 'step_up_required',
        action: 'identity.system-settings-change',
      });
    const key = decodeURIComponent(path.split('/').at(-1) ?? '');
    const setting = mock.settings.find((item) => item.key === key);
    if (!setting) return route.fulfill({ status: 400 });
    const value = (request.postDataJSON() as { value: unknown }).value;
    if (
      (key === 'training.off-contact' && (typeof value !== 'string' || !value.includes('@'))) ||
      (key === 'devices.max-per-guest' && (typeof value !== 'number' || value < 1 || value > 20)) ||
      (key === 'training.photo-storage-enabled' && typeof value !== 'boolean')
    ) {
      return problem(route, 400, 'validation-failed', 'Valor inválido.');
    }
    setting.value = value as string | number | boolean;
    setting.source = 'app';
    identity.stepUpValid = false;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(setting),
    });
  });

  // A leitura de saúde lista os computadores pareados: o mesmo conjunto da configuração da TV.
  await context.route('**/api/v1/devices/agents', async (route) => {
    if (identity.offline) return route.abort('internetdisconnected');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        mock.computers
          .filter((computer) => !computer.revoked)
          .map((computer, index) => ({
            id: `00000000-0000-4000-8000-00000000010${index}`,
            slug: computer.slug,
            name: computer.name,
            connected: computer.online,
            lastSeenAt: '2026-10-28T09:00:00Z',
          })),
      ),
    });
  });

  // Só o administrador lê o que os agentes contaram sobre si.
  await context.route('**/api/v1/devices/agents/diagnostics**', async (route) => {
    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = route
      .request()
      .headers()
      ['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer))
      return problem(route, 401, 'unauthenticated', 'Sessão inválida.');
    if (identity.role !== 'owner') return route.fulfill({ status: 403 });
    if (mock.failDiagnostics > 0) {
      mock.failDiagnostics -= 1;
      return problem(route, 500, 'internal-error', 'Erro.');
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ retentionDays: 7, items: mock.diagnostics }),
    });
  });

  await context.route('**/api/v1/tv/config**', async (route) => {
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
    if (identity.role !== 'owner') return route.fulfill({ status: 403 });

    if (method === 'GET' && path === '/config') {
      if (mock.failReads > 0) {
        mock.failReads -= 1;
        return problem(route, 500, 'internal-error', 'Erro.');
      }
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(view(mock)),
      });
    }

    if (method === 'PUT' && path === '/config/agent') {
      if (!identity.stepUpValid) {
        return problem(route, 403, 'step-up-required', 'Confirme com a passkey.', {
          code: 'step_up_required',
          action: 'tv.bind-agent',
        });
      }
      const slug = String(body?.['agentSlug'] ?? '');
      const chosen = mock.computers.find((c) => c.slug === slug && !c.revoked);
      if (!chosen) {
        return problem(route, 400, 'validation-failed', 'Um ou mais campos são inválidos.', {
          errors: { agentSlug: ['Escolha um dos computadores pareados da lista.'] },
        });
      }
      mock.current = chosen.slug;
      mock.source = 'saved';
      identity.stepUpValid = false;
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(view(mock)),
      });
    }

    return route.fulfill({ status: 404 });
  });

  return mock;
}
