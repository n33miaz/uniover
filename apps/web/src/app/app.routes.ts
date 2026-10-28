import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { moduleGuard, ownerOnlyGuard } from './core/auth/role.guard';
import { welcomeGuard } from './core/auth/welcome.guard';
import { AppShell } from './core/layout/app-shell';
import { ShellBack } from './core/layout/route-data';
import { SETTINGS_TITLES } from './modules/settings/settings-titles';

/** Cada tela de Configurações volta para a lista, não para o Início. */
const SETTINGS_BACK: ShellBack = {
  link: '/ajustes',
  label: $localize`:@@settings.back-label:Voltar às Configurações`,
};

// Cada módulo de tela é uma rota preguiçosa. O `data.title` de uma rota liga o cabeçalho do shell (com o
// retorno ao Início) e as abas vêm do `data.tabs` da rota filha do próprio módulo. O convidado alcança os módulos que a
// conta dele libera (a TV e o Treino, cada um pela permissão `module:*`) e a parte de Ajustes que é dele (lista, Perfil,
// Aparência e Sobre): o que sobra leva `ownerOnlyGuard` (e a API recusa com 403 de qualquer jeito). Quem não pode usar
// um módulo volta à Início, que mostra somente o que a conta pode abrir.
export const routes: Routes = [
  {
    // O celular onde a pessoa já entrou abre o QR de um computador aqui e confirma. Exige sessão: quem ainda não entrou
    // passa pelo login e volta (o `next` aceita esta rota). Vem antes de `entrar` e fora da casca.
    path: 'entrar/qr',
    canMatch: [authGuard],
    loadComponent: () => import('./core/auth/qr/qr-approve.page').then((m) => m.QrApprovePage),
  },
  {
    path: 'entrar',
    loadComponent: () => import('./core/auth/login.page').then((m) => m.LoginPage),
  },
  {
    // Quem está no PC baixa o conector sem conta: fica fora da casca e sem guarda de login. O arquivo em si
    // (`/conectar/conectar-uniover.cmd`) é estático; só a rota sem arquivo cai neste app.
    path: 'conectar',
    loadComponent: () => import('./modules/devices/connect.page').then((m) => m.ConnectPage),
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
        loadChildren: () => import('./modules/home/home.routes').then((m) => m.HOME_ROUTES),
      },
      {
        path: 'tv',
        canMatch: [moduleGuard('tv')],
        data: { title: $localize`:@@module.tv.title:TV` },
        loadChildren: () => import('./modules/tv/tv.routes').then((m) => m.TV_ROUTES),
      },
      {
        path: 'treino',
        canMatch: [moduleGuard('training')],
        data: { title: $localize`:@@module.training.title:Treino` },
        loadChildren: () =>
          import('./modules/training/training.routes').then((m) => m.TRAINING_ROUTES),
      },
      // Endereços antigos continuam úteis, mas a tela deixou de existir: toda conta tem a própria Início.
      { path: 'sem-acesso', pathMatch: 'full', redirectTo: '/' },
      {
        // Configurações é uma lista; cada linha abre uma tela filha, com a seta voltando para a lista.
        path: 'ajustes',
        data: { title: $localize`:@@settings.title:Configurações`, settings: true },
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
            path: 'auditoria',
            canMatch: [ownerOnlyGuard],
            data: { title: SETTINGS_TITLES.audit, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/audit.page').then((m) => m.AuditPage),
          },
          {
            path: 'sistema',
            canMatch: [ownerOnlyGuard],
            data: { title: SETTINGS_TITLES.system, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/system.page').then((m) => m.SystemPage),
          },
          {
            // Destino do QR que o agente mostra no PC (`?codigo=`). Sem `ownerOnlyGuard` de propósito: o convidado que o
            // abre vê o aviso "peça ao administrador" em vez de ser levado embora sem explicação. A tela só mostra o
            // aviso para ele (nenhuma chamada à API), e a API recusa com 403 de qualquer jeito.
            path: 'dispositivos',
            data: { title: $localize`:@@devices.route.title:Dispositivos`, back: SETTINGS_BACK },
            loadComponent: () =>
              import('./modules/devices/devices.page').then((m) => m.DevicesPage),
          },
          {
            // Links e atalhos salvos antes da reorganização seguem chegando à tela nova.
            path: 'aparelhos',
            pathMatch: 'full',
            redirectTo: 'dispositivos',
          },
          {
            path: 'sobre',
            data: { title: SETTINGS_TITLES.about, back: SETTINGS_BACK },
            loadComponent: () => import('./modules/settings/about.page').then((m) => m.AboutPage),
          },
          {
            // As telas do Treino (a ficha do exercício, a linha de crédito da ilustração) levam a esta: quem usa o Treino
            // tem de poder abrir.
            path: 'creditos',
            canMatch: [moduleGuard('training')],
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
