/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  PrecacheEntry,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { swapIfSafe } from './sw-swap-gate';
import { SCOPED_MODULE_SLUGS } from './app/core/modules/module-slugs';
import { EXERCISE_ART_CACHE } from './app/modules/training/illustrations/illustration-cache';

declare const self: ServiceWorkerGlobalScope & {
  // O build troca este marcador pela lista de arquivos da casca (com hash de conteúdo).
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// Atualização controlada: um worker novo espera até a pessoa tocar em "Atualizar" (SKIP_WAITING) ou até a próxima abertura a
// frio. A troca automática (SWAP_IF_SAFE, pedida pela aba numa navegação ociosa ou na recuperação de um pedaço ausente) só
// acontece se NENHUMA aba aberta tiver trabalho não salvo, porque o `clientsClaim` troca o worker de todas. Na primeira
// instalação não há worker anterior, então ele já assume sozinho.
const TAB_ANSWER_TIMEOUT_MS = 1_500;

function askTab(client: Client): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(undefined);
    }, TAB_ANSWER_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve((event.data as { busy?: boolean } | null)?.busy !== false);
    };
    client.postMessage({ type: 'ARE_YOU_BUSY' }, [channel.port2]);
  });
}

async function swapWhenEveryTabIsFree(reply: MessagePort | undefined): Promise<void> {
  const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const verdict = await swapIfSafe(
    tabs.map((tab) => () => askTab(tab)),
    () => self.skipWaiting(),
  );
  reply?.postMessage(verdict);
}

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: string } | undefined)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  else if (type === 'SWAP_IF_SAFE') event.waitUntil(swapWhenEveryTabIsFree(event.ports[0]));
});
clientsClaim();
cleanupOutdatedCaches();

// A casca: JS/CSS/fontes com hash e as páginas `/`, `/tv/` e `/treino/` (o build as acrescenta; elas vêm
// do servidor, já com o manifest do módulo e o nonce da CSP trocados). O `index.html` cru não entra.
precacheAndRoute(self.__WB_MANIFEST);

// A API nunca fica em cache. Só `GET` passa por aqui; `POST` e afins seguem direto para a rede, e o reenvio
// de escritas feitas offline é da fila do app, não do service worker.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/api/'),
  new NetworkOnly(),
);

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
