// Servidor de teste do e2e e da auditoria: entrega dist/web/browser como a API entrega (ver app-server.mjs).
import { fileURLToPath } from 'node:url';
import { createAppServer } from './app-server.mjs';

const root = fileURLToPath(new URL('../../dist/web/browser', import.meta.url));
const port = Number(process.argv[2] ?? 4300);

createAppServer({
  resolveRoot: () => root,
  // Só para testar a troca de versão do service worker: o cookie muda os bytes do sw.js desta sessão.
  transformSw: (body, req) => {
    const variant = /(?:^|;\s*)sw-variant=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    return variant ? Buffer.concat([body, Buffer.from(`\n// variant ${variant}\n`)]) : body;
  },
}).listen(port, () => console.log(`servidor de teste em http://localhost:${port}`));
