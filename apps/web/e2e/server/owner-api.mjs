// API mínima do dono para o e2e de atualização: o servidor de versões responde a sessão, a conta e o estado da TV sem
// passar pelas rotas do Playwright (que não enxergam o que o service worker repassa). Só o que a Início lê ao abrir.

const JSON_TYPE = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(res, status, body) {
  res.writeHead(status, JSON_TYPE).end(JSON.stringify(body));
}

const PERMISSIONS = [
  'module:tv',
  'tv:control',
  'tv:power',
  'tv:launch',
  'tv:edit-shortcuts',
  'tv:history',
  'module:training',
];

let counter = 0;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Devolve o tratador `api` do `createAppServer`: com `isOwner()` falso não responde (cai no 404 padrão). `meDelayMs()`
 * alonga só a leitura da conta (o banco acordando depois de a sessão já ter sido aceita).
 */
export function createOwnerApi({ isOwner, meDelayMs = () => 0 }) {
  return async (req, res, pathname) => {
    if (!isOwner()) return false;
    const path = pathname.replace(/^\/api\/v1/, '');
    if (req.method === 'POST' && path === '/identity/auth/refresh') {
      const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', n: ++counter })}.assinatura`;
      json(res, 200, { accessToken: token, expiresIn: 600 });
      return true;
    }
    if (req.method === 'GET' && path === '/identity/me') {
      await new Promise((done) => setTimeout(done, meDelayMs()));
      json(res, 200, {
        id: 'u1',
        email: 'dono@exemplo.com',
        displayName: 'Dono da Casa',
        role: 'owner',
        displayNameConfirmed: true,
        permissions: PERMISSIONS,
      });
      return true;
    }
    if (req.method === 'POST' && path === '/identity/auth/stream-ticket') {
      json(res, 200, { expiresIn: 120 });
      return true;
    }
    if (req.method === 'GET' && path === '/tv/state') {
      json(res, 200, {
        power: 'on',
        volume: 22,
        app: null,
        connection: 'hot',
        agentOnline: true,
        updatedAt: '2026-10-19T14:02:00Z',
      });
      return true;
    }
    if (req.method === 'GET' && path === '/devices/agent-alerts') {
      json(res, 200, []);
      return true;
    }
    if (req.method === 'GET' && path === '/tv/events') {
      // Fluxo aberto e calado: o app só precisa de uma conexão viva.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': aberto\n\n');
      return true;
    }
    return false;
  };
}
