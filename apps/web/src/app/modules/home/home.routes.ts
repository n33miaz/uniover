import { Routes } from '@angular/router';
import { LiveHomeStatus } from '../../core/status/live-home-status';
import { HomeStatusPort } from '../../core/status/home-status.port';

export const HOME_ROUTES: Routes = [
  {
    path: '',
    // O fluxo de estado só existe na Início; mantê-lo neste injetor evita que a API e o SSE entrem no pacote inicial.
    providers: [{ provide: HomeStatusPort, useExisting: LiveHomeStatus }],
    loadComponent: () => import('./home-page').then((m) => m.HomePage),
  },
];
