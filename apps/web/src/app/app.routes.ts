import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { AppShell } from './core/layout/app-shell';

// Cada módulo de tela é uma rota preguiçosa. O `data.title` de uma rota liga o cabeçalho do shell (com o
// retorno ao Início) e as abas vêm do `data.tabs` da rota filha do próprio módulo.
export const routes: Routes = [
  {
    path: 'entrar',
    loadComponent: () => import('./core/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    component: AppShell,
    canMatch: [authGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadChildren: () => import('./modules/home/home.routes').then((m) => m.HOME_ROUTES),
      },
      {
        path: 'tv',
        data: { title: $localize`:@@module.tv.title:TV` },
        loadChildren: () => import('./modules/tv/tv.routes').then((m) => m.TV_ROUTES),
      },
      {
        path: 'treino',
        data: { title: $localize`:@@module.training.title:Treino` },
        loadChildren: () =>
          import('./modules/training/training.routes').then((m) => m.TRAINING_ROUTES),
      },
      {
        path: 'ajustes/aparelhos',
        data: { title: $localize`:@@devices.route.title:Aparelhos` },
        loadComponent: () => import('./modules/devices/devices.page').then((m) => m.DevicesPage),
      },
      {
        path: 'ajustes',
        data: { title: $localize`:@@settings.title:Ajustes` },
        loadComponent: () => import('./modules/settings/settings.page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
