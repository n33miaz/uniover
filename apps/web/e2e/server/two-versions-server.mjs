// Servidor do e2e de atualização: serve o build `a` e, trocando por um endpoint de controle, a "versão seguinte" `b`
// (ver next-version.mjs), como um deploy no meio do uso. Só o teste o liga (processo próprio, porta livre).
//
//   node e2e/server/two-versions-server.mjs <pasta-do-build> [--first-visit]
//
// Na primeira visita só há a versão atual, então o servidor usa o build sem copiar uma segunda versão.
// Escreve uma linha JSON `{ "port": N, "tmp": "<pasta da versão b>" }` quando está pronto. Controle (GET):
//   /use?v=a|b                 qual versão responde daqui em diante
//   /sw-delay?ms=N             a versão b só obedece ao SKIP_WAITING depois de N ms (um aparelho lento)
//   /api-delay?ms=N            a API (que no teste responde 404) demora N ms para responder
//   /me-delay?ms=N             com /owner, só a leitura da conta (/me) demora N ms a mais
//   /hold-install?on=1|0       segura ou libera o evento install no cenário --first-visit
//   /owner?on=1                a API passa a responder como o dono já conectado (sessão, conta e estado da TV)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAppServer } from './app-server.mjs';
import { createNextVersion } from './next-version.mjs';
import { createOwnerApi } from './owner-api.mjs';

const rootA = resolve(process.argv[2] ?? '');
const firstVisitOnly = process.argv.includes('--first-visit');
const tmp = firstVisitOnly ? undefined : await mkdtemp(join(tmpdir(), 'uniover-next-'));
const rootB = tmp ? join(tmp, 'browser') : rootA;
if (tmp) await createNextVersion(rootA, rootB);

let installGate;
function holdInstall(hold) {
  if (hold) {
    installGate ??= Promise.withResolvers();
  } else {
    installGate?.resolve();
    installGate = undefined;
  }
}

const state = {
  version: 'a',
  swDelayMs: 0,
  apiDelayMs: 0,
  meDelayMs: 0,
  owner: false,
};

// `/health/version` responde como a API de verdade: o app o usa de sonda de rede antes de desfazer um worker travado.
const ownerApi = (() => {
  const owner = createOwnerApi({ isOwner: () => state.owner, meDelayMs: () => state.meDelayMs });
  return async (req, res, pathname) => {
    if (pathname === '/api/e2e/finish-install' && firstVisitOnly) {
      await installGate?.promise;
      res.writeHead(204, { 'cache-control': 'no-store' }).end();
      return true;
    }
    if (req.method === 'GET' && pathname === '/health/version') {
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ version: 'e2e', commit: 'e2e' }));
      return true;
    }
    return owner(req, res, pathname);
  };
})();

const app = createAppServer({
  resolveRoot: () => (state.version === 'b' ? rootB : rootA),
  transformSw: (body) => {
    if (firstVisitOnly) {
      // O app registra e ativa o worker real. A resposta do servidor só decide quando o install pode terminar.
      const prelude =
        "self.addEventListener('install', e => e.waitUntil(fetch('/api/e2e/finish-install')));\n";
      return Buffer.concat([Buffer.from(prelude), body]);
    }
    if (state.version !== 'b' || state.swDelayMs <= 0) return body;
    // Por ser o primeiro ouvinte de `message`, segura o pedido SKIP_WAITING e o entrega de novo ao sw.ts depois do atraso
    // (marcado, para não ser seguro outra vez): é o que um celular lento ou ocupado faz com a ativação, e o worker de verdade
    // (que só toma as páginas abertas depois desse pedido, ver sw-claim.ts) segue o caminho real.
    const prelude =
      `self.addEventListener('message',function(e){if(e.data&&e.data.type==='SKIP_WAITING'&&!e.data.delayed){` +
      `e.stopImmediatePropagation();setTimeout(function(){self.dispatchEvent(new ExtendableMessageEvent('message',` +
      `{data:{type:'SKIP_WAITING',delayed:true}}))},${state.swDelayMs})}});\n`;
    return Buffer.concat([Buffer.from(prelude), body]);
  },
  // Sem cache HTTP: o navegador pode ter tirado do disco os arquivos da versão antiga (o iOS o faz cedo); o que o worker
  // não guarda, vem da rede, e a rede só tem a versão nova.
  assetCache: 'no-store',
  beforeApi: () => new Promise((done) => setTimeout(done, state.apiDelayMs)),
  api: ownerApi,
});

const server = app.listen(0, () => {
  console.log(JSON.stringify({ port: server.address().port, tmp }));
});

// Os controles ficam num servidor à parte para não depender de nenhuma rota do app.
const control = (await import('node:http')).createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/use') state.version = url.searchParams.get('v') === 'b' ? 'b' : 'a';
  if (url.pathname === '/sw-delay') state.swDelayMs = Number(url.searchParams.get('ms') ?? 0);
  if (url.pathname === '/api-delay') state.apiDelayMs = Number(url.searchParams.get('ms') ?? 0);
  if (url.pathname === '/me-delay') state.meDelayMs = Number(url.searchParams.get('ms') ?? 0);
  if (url.pathname === '/hold-install' && firstVisitOnly)
    holdInstall(url.searchParams.get('on') === '1');
  if (url.pathname === '/owner') state.owner = url.searchParams.get('on') === '1';
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
});
control.listen(0, () => {
  console.log(JSON.stringify({ control: control.address().port }));
});
