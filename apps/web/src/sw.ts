/// <reference lib="webworker" />
import {
  PrecacheEntry,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheFirst } from 'workbox-strategies';
import { SCOPED_MODULE_SLUGS } from './app/core/modules/module-slugs';
import { createClaimPolicy } from './app/core/pwa/sw-claim';
import { LIST_CLIENTS_MESSAGE, answerClientsQuery } from './app/core/pwa/sw-clients';
import { EXERCISE_ART_CACHE } from './app/modules/training/illustrations/illustration-cache';

declare const self: ServiceWorkerGlobalScope & {
  // O build troca este marcador pela lista de arquivos da casca (com hash de conteúdo).
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// Atualização controlada: um worker novo espera até o app pedir para não trocar a casca no meio do uso. O pedido
// (SKIP_WAITING) sai do app: toque no aviso, ou a primeira navegação/ida ao segundo plano sem trabalho em curso, com as
// outras abas conferidas. Sem pedido, o worker que espera ativa sozinho quando a última página dele fecha (a próxima
// abertura a frio). O worker só toma as páginas abertas (clients.claim) na primeira instalação ou depois desse pedido,
// nunca por conta própria no meio de uma operação (ver sw-claim.ts). Uma aba ocupada que mesmo assim seja tomada adia a
// própria recarga (PwaUpdateService) e busca na rede os pedaços que faltarem, onde a imagem do servidor guarda os
// arquivos com hash das últimas versões.
const claim = createClaimPolicy();
self.addEventListener('install', () => claim.onInstall(self.registration.active !== null));
self.addEventListener('message', (event) => {
  const type = (event.data as { type?: string } | undefined)?.type;
  // A página pergunta, antes de pedir a troca, quantas janelas do app existem (a lista autoritativa, ver sw-clients.ts).
  if (type === LIST_CLIENTS_MESSAGE) {
    const source = event.source;
    const askerId = source && 'id' in source ? source.id : null;
    event.waitUntil(answerClientsQuery(self, askerId, event.ports[0]));
    return;
  }
  if (type !== 'SKIP_WAITING') return;
  claim.onSkipWaitingRequest();
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  if (claim.shouldClaim()) event.waitUntil(self.clients.claim());
});
cleanupOutdatedCaches();

// A casca: JS/CSS/fontes com hash e as páginas `/`, `/tv/`, `/treino/` e `/pc/` (o build as acrescenta; elas vêm
// do servidor, já com o manifest do módulo e o nonce da CSP trocados). O `index.html` cru não entra.
precacheAndRoute(self.__WB_MANIFEST);

// A API não passa pelo worker: sem rota para `/api/`, ele não responde e o navegador busca direto na rede (nada fica em
// cache). Responder aqui, mesmo só repassando, prendia o worker a cada pedido em aberto, e o fluxo de eventos
// (`EventSource`) fica aberto por minutos: no Chrome o worker novo não assume enquanto o antigo tem pedido em curso, então
// o toque em "Atualizar" estourava o prazo e, com outra aba aberta, a página recarregava na versão antiga, em laço.

// Ilustrações dos exercícios: não entram no precache; ficam em cache na primeira vez que são vistas (ou quando o
// app as aquece com rede). Os arquivos nunca mudam de conteúdo para o mesmo nome, então vale cache primeiro.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/exercise-art/'),
  new CacheFirst({
    cacheName: EXERCISE_ART_CACHE,
    plugins: [new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 90 * 24 * 60 * 60 })],
  }),
);

const denylist = [/^\/api(\/|$)/, /^\/health(\/|$)/, /^\/openapi/, /^\/conectar\/.+\.cmd$/];

// Um roteador de navegação por escopo: dentro de /tv/ a página servida offline continua sendo a que traz o
// manifest da TV, senão "Adicionar à Tela de Início" a partir dali instalaria o app da raiz.
for (const slug of SCOPED_MODULE_SLUGS) {
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL(`/${slug}/`), {
      allowlist: [new RegExp(`^/${slug}(/|$)`)],
      denylist,
    }),
  );
}
registerRoute(new NavigationRoute(createHandlerBoundToURL('/'), { denylist }));
