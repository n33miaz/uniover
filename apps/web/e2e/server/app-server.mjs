// Núcleo do servidor de teste do e2e e da auditoria: entrega uma pasta de build como a API entrega (mesmo contrato
// do index.html). Troca __CSP_NONCE__ por um nonce novo a cada resposta, troca <!--uniover:manifest--> pelos links
// do manifest do módulo e envia a CSP padrão da API. Limitação conhecida: esta cópia da CSP pode divergir da da
// API; o teste contra o contêiner real repete a checagem.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

// Módulos com manifest próprio (a mesma lista de src/app/core/modules/module-slugs.ts).
const SCOPED_SLUGS = ['tv', 'treino'];

const CSP_TEMPLATE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function manifestLinks(pathname) {
  const slug = pathname.split('/')[1];
  const base = SCOPED_SLUGS.includes(slug) ? `/${slug}` : '';
  return (
    `<link rel="manifest" href="${base}/manifest.webmanifest">` +
    `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">`
  );
}

async function sendPage(root, pathname, res, head) {
  const nonce = randomBytes(16).toString('base64');
  const html = (await readFile(join(root, 'index.html'), 'utf8'))
    .replaceAll('__CSP_NONCE__', nonce)
    .replace('<!--uniover:manifest-->', manifestLinks(pathname));
  res.writeHead(200, {
    'content-type': TYPES['.html'],
    'content-security-policy': CSP_TEMPLATE.replace('{nonce}', nonce),
    'cache-control': 'no-cache',
  });
  res.end(head ? undefined : html);
}

/**
 * Cria o servidor (sem ligar a porta). `resolveRoot(req)` diz de qual pasta de build a resposta sai (o e2e de
 * atualização troca de versão no meio do teste); `transformSw(body, req)` pode alterar os bytes do `/sw.js`; `beforeApi(req)` pode atrasar as respostas da API;
 * `api(req, res, pathname)` pode responder no lugar do 404 padrão (devolve `true` quando respondeu).
 */
export function createAppServer({
  resolveRoot,
  transformSw = (body) => body,
  beforeApi = async () => undefined,
  api = async () => false,
  assetCache = 'public, max-age=31536000, immutable',
}) {
  return createServer(async (req, res) => {
    try {
      const root = resolveRoot(req);
      const url = new URL(req.url, 'http://x');
      const pathname = normalize(decodeURIComponent(url.pathname)).split(sep).join('/');
      const head = req.method === 'HEAD';
      // A API simulada aceita qualquer método (a sessão nasce de um POST); o resto do servidor só entrega arquivos.
      if (req.method !== 'GET' && !head && !url.pathname.startsWith('/api/')) {
        res.writeHead(405).end();
        return;
      }
      const ext = extname(pathname);
      if (ext && ext !== '.html') {
        const file = join(root, pathname);
        if (!file.startsWith(root)) throw new Error('fora da raiz');
        let body = await readFile(file);
        if (pathname === '/sw.js') body = transformSw(body, req);
        const cache = pathname === '/sw.js' ? 'no-cache' : assetCache;
        res.writeHead(200, {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'cache-control': cache,
        });
        res.end(head ? undefined : body);
        return;
      }
      if (pathname === '/health/live') {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
        return;
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/health')) {
        await beforeApi(req);
        if (await api(req, res, pathname)) return;
        res.writeHead(req.method === 'GET' || head ? 404 : 405).end();
        return;
      }
      await sendPage(root, pathname, res, head);
    } catch {
      res.writeHead(404).end();
    }
  });
}
