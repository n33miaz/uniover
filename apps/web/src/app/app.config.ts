import { DOCUMENT } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  Injector,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withNavigationErrorHandler } from '@angular/router';
import { routes } from './app.routes';
import { idempotencyInterceptor } from './core/api/idempotency.interceptor';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';
import { connectivityInterceptor } from './core/connectivity/connectivity.interceptor';
import { watchKeyboardInset } from './core/layout/keyboard-inset';
import { ChunkAwareErrorHandler, recoverFromChunkNavigationError } from './core/pwa/chunk-error';
import { InstallHintService } from './core/pwa/install-hint.service';
import { ModuleHeadService } from './core/pwa/module-head.service';
import { PwaUpdateService } from './core/pwa/pwa-update.service';
import { HomeStatusPort } from './core/status/home-status.port';
import { LiveHomeStatus } from './core/status/live-home-status';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Sem `withViewTransitions`: no WebKit do Playwright (Windows), a transição nativa de tela junto das animações de
    // entrada (`ui-rise`) derrubava a página em cerca de 1 a cada 4 execuções do mesmo fluxo; sem uma das duas, nunca.
    // A tela nova entra pelas animações de entrada dela mesma (`ui-rise` e `ui-stagger`, em styles.css).
    // Um pedaço de código que sumiu (a casca aberta é de antes do deploy) atualiza o app sozinho em vez de deixar a tela vazia.
    provideRouter(routes, withNavigationErrorHandler(recoverFromChunkNavigationError)),
    { provide: ErrorHandler, useClass: ChunkAwareErrorHandler },
    // A Início lê o estado da casa pela porta; o adaptador real fala com a API e com o fluxo em tempo real.
    { provide: HomeStatusPort, useExisting: LiveHomeStatus },
    provideHttpClient(
      withFetch(),
      // A chave de idempotência vem depois da autenticação: cada repetição dela (renovação, passkey) decide a sua chave.
      withInterceptors([connectivityInterceptor, authInterceptor, idempotencyInterceptor]),
    ),
    // Registra o service worker sem segurar a primeira tela (só em produção).
    provideAppInitializer(() => inject(PwaUpdateService).start()),
    // Guarda o pedido de instalação do navegador (Chromium o entrega uma vez, cedo, antes de a sessão confirmar).
    provideAppInitializer(() => inject(InstallHintService).start()),
    // Mantém --kb-inset (teclado virtual) para os rodapés fixos subirem junto.
    provideAppInitializer(() => {
      const doc = inject(DOCUMENT);
      if (doc.defaultView) watchKeyboardInset(doc.defaultView, doc.documentElement);
    }),
    // Acerta manifest, ícone e nome do <head> pelo módulo aberto (o servidor só os escolhe ao entregar a página).
    provideAppInitializer(() => inject(ModuleHeadService).start()),
    // Confirma a sessão pelo cookie de refresh sem segurar a primeira tela (o guarda espera, com limite de tempo).
    provideAppInitializer(() => {
      void inject(AuthService).init();
    }),
    // Liga a fila offline da conta em uso (cada conta tem a sua) e a segue a cada troca de conta: sobe o que ficou pendente
    // de uma sessão anterior. Sem conta conhecida ainda (nenhuma dica, `/me` por chegar) nada é aberto; a fila abre quando
    // a conta aparece. O import dinâmico deixa o banco local e o motor fora do pacote inicial: a primeira tela não espera.
    provideAppInitializer(() => {
      const injector = inject(Injector);
      void import('./core/offline-queue/queue-scopes').then(({ QueueScopes }) =>
        injector.get(QueueScopes).follow(),
      );
    }),
  ],
};
