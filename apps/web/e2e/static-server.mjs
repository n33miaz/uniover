// Servidor estático mínimo para o e2e: entrega dist/web/browser com fallback para o index.html (SPA).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist', 'web', 'browser');
const port = Number(process.argv[2] ?? 4300);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const candidate = join(root, path);
  try {
    if (!candidate.startsWith(root)) throw new Error('fora da raiz');
    const body = await readFile(extname(candidate) ? candidate : join(root, 'index.html'));
    res.writeHead(200, { 'content-type': types[extname(candidate)] ?? 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': types['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }
}).listen(port, () => console.log(`e2e server em http://localhost:${port}`));
