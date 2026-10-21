import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { ownerOnlyGuard } from './core/auth/role.guard';
import { welcomeGuard } from './core/auth/welcome.guard';
import { AppShell } from './core/layout/app-shell';
import { ShellBack } from './core/layout/route-data';
import { SETTINGS_TITLES } from './modules/settings/settings-titles';

/** Cada tela de Ajustes volta para a lista, não para o Início. */
const SETTINGS_BACK: ShellBack = {
  link: '/ajustes',
  label: $localize`:@@settings.back-label:Voltar aos Ajustes`,
};

// Cada módulo de tela é uma rota preguiçosa. O `data.title` de uma rota liga o cabeçalho do shell (com o
// retorno ao Início) e as abas vêm do `data.tabs` da rota filha do próprio módulo. O convidado alcança a TV e a parte
// de Ajustes que é dele (lista, Perfil, Aparência e Sobre): tudo o mais leva `ownerOnlyGuard` (e a API recusa com 403
// de qualquer jeito).
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
    // Primeiro acesso: a pergunta do nome fica fora da casca (e do guarda de boas-vindas, para nunca haver laço), mas
    // exige sessão: quem não entrou vai para a tela de entrada.
    path: 'boas-vindas',
    canMatch: [authGuard],
    loadComponent: () => import('./core/auth/welcome.page').then((m) => m.WelcomePage),
  },
  {
    path: '',
    component: AppShell,
    // Entrar primeiro; depois, quem ainda não escolheu o nome responde à pergunta antes de qualquer tela.
    canMatch: [authGuard, welcomeGuard],
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
        // Ajustes é uma lista; cada linha abre uma tela filha, com a seta voltando para a lista.
        path: 'ajustes',
        data: { title: $localize`:@@settings.title:Ajustes`, settings: true },
        children: [
          {
            path: '',
            pathMatch: 'full',
            loadComponent: () =>
              import('./modules/settings/settings.page').then((m) => m.SettingsPage),
          },
          {
            path: 'perfil',
            data: { title: SETTINGS_TITLES.profile, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/settings/profile.page').then((m) => m.ProfilePage),
          },
          {
            path: 'aparencia',
            data: { title: SETTINGS_TITLES.appearance, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/settings/appearance.page').then((m) => m.AppearancePage),
          },
          {
            path: 'seguranca',
            canMatch: [ownerOnlyGuard],
            data: { title: SETTINGS_TITLES.security, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/settings/security.page').then((m) => m.SecurityPage),
          },
          {
            path: 'pessoas',
            canMatch: [ownerOnlyGuard],
            data: { title: SETTINGS_TITLES.people, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/people.page').then((m) => m.PeoplePage),
          },
          {
            path: 'sistema',
            canMatch: [ownerOnlyGuard],
            data: { title: SETTINGS_TITLES.system, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/system.page').then((m) => m.SystemPage),
          },
          {
            path: 'aparelhos',
            canMatch: [ownerOnlyGuard],
            data: { title: $localize`:@@devices.route.title:Aparelhos`, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/devices/devices.page').then((m) => m.DevicesPage),
          },
          {
            path: 'sobre',
            data: { title: SETTINGS_TITLES.about, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/about.page').then((m) => m.AboutPage),
          },
          {
            path: 'creditos',
            canMatch: [ownerOnlyGuard],
            data: { title: $localize`:@@credits.route.title:Créditos`, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/training/credits/credits.page').then((m) => m.CreditsPage),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
