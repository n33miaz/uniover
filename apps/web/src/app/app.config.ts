import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  Injector,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';
import { connectivityInterceptor } from './core/connectivity/connectivity.interceptor';
import { InstallHintService } from './core/pwa/install-hint.service';
import { PwaUpdateService } from './core/pwa/pwa-update.service';
import { HomeStatusPort } from './core/status/home-status.port';
import { LiveHomeStatus } from './core/status/live-home-status';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Sem `withViewTransitions`: no WebKit do Playwright (Windows), a transição nativa de tela junto das animações de
    // entrada (`ui-rise`) derrubava a página em cerca de 1 a cada 4 execuções do mesmo fluxo; sem uma das duas, nunca.
    // A tela nova entra pelas animações de entrada dela mesma (`ui-rise` e `ui-stagger`, em styles.css).
    provideRouter(routes),
    // A Início lê o estado da casa pela porta; o adaptador real fala com a API e com o fluxo em tempo real.
    { provide: HomeStatusPort, useExisting: LiveHomeStatus },
    provideHttpClient(withFetch(), withInterceptors([connectivityInterceptor, authInterceptor])),
    // Registra o service worker sem segurar a primeira tela (só em produção).
    provideAppInitializer(() => inject(PwaUpdateService).start()),
    // Guarda o pedido de instalação do navegador (Chromium o entrega uma vez, cedo, antes de a sessão confirmar).
    provideAppInitializer(() => inject(InstallHintService).start()),
    // Confirma a sessão pelo cookie de refresh sem segurar a primeira tela (o guarda espera, com limite de tempo).
    provideAppInitializer(() => {
      void inject(AuthService).init();
    }),
    // Sobe o que ficou na fila offline de uma sessão anterior. O import dinâmico deixa o banco local e o motor fora do
    // pacote inicial: a primeira tela não espera por eles.
    provideAppInitializer(() => {
      const injector = inject(Injector);
      void import('./core/offline-queue/sync-engine').then(({ SyncEngine }) =>
        injector.get(SyncEngine).start(),
      );
    }),
  ],
};
