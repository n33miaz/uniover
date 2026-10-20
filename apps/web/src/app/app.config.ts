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
import { PwaUpdateService } from './core/pwa/pwa-update.service';
import { HomeStatusPort } from './core/status/home-status.port';
import { LiveHomeStatus } from './core/status/live-home-status';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // A Início lê o estado da casa pela porta; o adaptador real fala com a API e com o fluxo em tempo real.
    { provide: HomeStatusPort, useExisting: LiveHomeStatus },
    provideHttpClient(withFetch(), withInterceptors([connectivityInterceptor, authInterceptor])),
    // Registra o service worker sem segurar a primeira tela (só em produção).
    provideAppInitializer(() => inject(PwaUpdateService).start()),
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
