/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  PrecacheEntry,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { SCOPED_MODULE_SLUGS } from './app/core/modules/module-slugs';

declare const self: ServiceWorkerGlobalScope & {
  // O build troca este marcador pela lista de arquivos da casca (com hash de conteúdo).
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// Atualização controlada: um worker novo espera até o app pedir (botão "Atualizar") para não trocar a
// casca no meio do uso. Na primeira instalação não há worker anterior, então ele já assume sozinho.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING')
    void self.skipWaiting();
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

const denylist = [/^\/api(\/|$)/, /^\/health(\/|$)/, /^\/openapi/];

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
