import { Routes } from '@angular/router';
import { moduleGuard, ownerOnlyGuard } from './core/auth/role.guard';
import { ShellBack } from './core/layout/route-data';
import { SETTINGS_TITLES } from './modules/settings/settings-titles';

/** O histórico de uma TV nasce na folha da TV, em Sistema: é para lá que ele volta. */
const SYSTEM_BACK: ShellBack = {
  link: '/ajustes/sistema',
  label: $localize`:@@settings.system-back-label:Voltar ao Sistema`,
};

/** Cada tela de Configurações volta para a lista, não para o Início. */
const SETTINGS_BACK: ShellBack = {
  link: '/ajustes',
  label: $localize`:@@settings.back-label:Voltar às Configurações`,
};

export const SETTINGS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./modules/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: 'perfil',
    data: { title: SETTINGS_TITLES.profile, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/profile.page').then((m) => m.ProfilePage),
  },
  {
    path: 'aparencia',
    data: { title: SETTINGS_TITLES.appearance, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/appearance.page').then((m) => m.AppearancePage),
  },
  {
    // Sem `ownerOnlyGuard`: o convidado vê só as próprias sessões (a tela esconde as passkeys, que são do dono).
    path: 'seguranca',
    data: { title: SETTINGS_TITLES.security, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/security.page').then((m) => m.SecurityPage),
  },
  {
    // Chaves dos Atalhos do iPhone: só o administrador (criar uma exige a passkey). Volta para Segurança, de onde se chega.
    path: 'seguranca/siri',
    canMatch: [ownerOnlyGuard],
    data: {
      title: SETTINGS_TITLES.siri,
      back: {
        link: '/ajustes/seguranca',
        label: $localize`:@@settings.siri.back-label:Voltar à Segurança`,
      },
    },
    loadComponent: () => import('./modules/settings/siri.page').then((m) => m.SiriPage),
  },
  {
    path: 'pessoas',
    canMatch: [ownerOnlyGuard],
    data: { title: SETTINGS_TITLES.people, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/people.page').then((m) => m.PeoplePage),
  },
  {
    // Só o administrador vê quem usa cada TV e de qual computador ela vem; as pessoas só veem o apelido da TV.
    path: 'tvs-por-pessoa',
    canMatch: [ownerOnlyGuard],
    data: { title: SETTINGS_TITLES.tvPeople, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/tv-people.page').then((m) => m.TvPeoplePage),
  },
  {
    // O histórico de uma TV é só do administrador: sem o guarda a rota nem casa para as demais contas.
    path: 'tv/:id/historico',
    canMatch: [ownerOnlyGuard],
    data: { title: SETTINGS_TITLES.tvHistory, back: SYSTEM_BACK },
    loadComponent: () => import('./modules/settings/tv-history.page').then((m) => m.TvHistoryPage),
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
    loadComponent: () => import('./modules/devices/devices.page').then((m) => m.DevicesPage),
  },
  {
    // Links e atalhos salvos antes da reorganização seguem chegando à tela nova.
    path: 'aparelhos',
    pathMatch: 'full',
    redirectTo: 'dispositivos',
  },
  {
    // Créditos abre como folha por cima de Sobre: é filha desta rota, e a tela de Sobre fica atrás.
    path: 'sobre',
    data: { title: SETTINGS_TITLES.about, back: SETTINGS_BACK },
    loadComponent: () => import('./modules/settings/about.page').then((m) => m.AboutPage),
    children: [
      {
        path: 'creditos',
        canMatch: [moduleGuard('training')],
        loadComponent: () =>
          import('./modules/training/credits/credits.page').then((m) => m.CreditsPage),
      },
    ],
  },
  {
    // As telas do Treino (a ficha do exercício, a linha de crédito da ilustração) levam a este endereço, que
    // abre a folha de Créditos sobre Sobre.
    path: 'creditos',
    pathMatch: 'full',
    redirectTo: 'sobre/creditos',
  },
];
