// Servidor de teste do e2e e da auditoria: entrega dist/web/browser como a API entrega (mesmo contrato do
// index.html). Troca __CSP_NONCE__ por um nonce novo a cada resposta, troca <!--uniover:manifest--> pelos links
// do manifest do módulo e envia a CSP padrão da API. Limitação conhecida: esta cópia da CSP pode divergir da da
// API; o teste contra o contêiner real repete a checagem.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../dist/web/browser', import.meta.url));
const port = Number(process.argv[2] ?? 4300);

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

async function sendPage(pathname, res, head) {
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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = normalize(decodeURIComponent(url.pathname)).split(sep).join('/');
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.writeHead(405).end();
      return;
    }
    const ext = extname(pathname);
    if (ext && ext !== '.html') {
      const file = join(root, pathname);
      if (!file.startsWith(root)) throw new Error('fora da raiz');
      let body = await readFile(file);
      // Só para testar a troca de versão do service worker: o cookie muda os bytes do sw.js desta sessão.
      if (pathname === '/sw.js') {
        const variant = /(?:^|;\s*)sw-variant=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
        if (variant) body = Buffer.concat([body, Buffer.from(`\n// variant ${variant}\n`)]);
      }
      const cache = pathname === '/sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable';
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
      res.writeHead(404).end();
      return;
    }
    await sendPage(pathname, res, head);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`servidor de teste em http://localhost:${port}`));
