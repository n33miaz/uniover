import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
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

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch(), withInterceptors([connectivityInterceptor, authInterceptor])),
    // Registra o service worker sem segurar a primeira tela (só em produção).
    provideAppInitializer(() => inject(PwaUpdateService).start()),
    // Confirma a sessão pelo cookie de refresh sem segurar a primeira tela (o guarda espera, com limite de tempo).
    provideAppInitializer(() => {
      void inject(AuthService).init();
    }),
  ],
};
