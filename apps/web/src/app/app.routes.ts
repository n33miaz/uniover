import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { ownerOnlyGuard } from './core/auth/role.guard';
import { AppShell } from './core/layout/app-shell';

// Cada módulo de tela é uma rota preguiçosa. O `data.title` de uma rota liga o cabeçalho do shell (com o
// retorno ao Início) e as abas vêm do `data.tabs` da rota filha do próprio módulo. O convidado só alcança a TV:
// tudo o mais leva `ownerOnlyGuard` (e a API recusa com 403 de qualquer jeito).
export const routes: Routes = [
  {
    path: 'entrar',
    loadComponent: () => import('./core/auth/login.page').then((m) => m.LoginPage),
  },
  {
    // O convite chega por link, sem sessão: fica fora da casca e do guarda de login.
    path: 'convite',
    loadComponent: () => import('./core/auth/accept-invite.page').then((m) => m.AcceptInvitePage),
  },
  {
    path: '',
    component: AppShell,
    canMatch: [authGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        canMatch: [ownerOnlyGuard],
        loadChildren: () => import('./modules/home/home.routes').then((m) => m.HOME_ROUTES),
      },
      {
        path: 'tv',
        data: { title: $localize`:@@module.tv.title:TV` },
        loadChildren: () => import('./modules/tv/tv.routes').then((m) => m.TV_ROUTES),
      },
      {
        path: 'treino',
        canMatch: [ownerOnlyGuard],
        data: { title: $localize`:@@module.training.title:Treino` },
        loadChildren: () =>
          import('./modules/training/training.routes').then((m) => m.TRAINING_ROUTES),
      },
      {
        path: 'ajustes/aparelhos',
        canMatch: [ownerOnlyGuard],
        data: { title: $localize`:@@devices.route.title:Aparelhos` },
        loadComponent: () => import('./modules/devices/devices.page').then((m) => m.DevicesPage),
      },
      {
        path: 'ajustes/creditos',
        canMatch: [ownerOnlyGuard],
        data: { title: $localize`:@@credits.route.title:Créditos` },
        loadComponent: () =>
          import('./modules/training/credits/credits.page').then((m) => m.CreditsPage),
      },
      {
        path: 'ajustes',
        canMatch: [ownerOnlyGuard],
        data: { title: $localize`:@@settings.title:Ajustes` },
        loadComponent: () => import('./modules/settings/settings.page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
