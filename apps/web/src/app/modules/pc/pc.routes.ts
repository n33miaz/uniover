import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import type { ShellBack } from '../../core/layout/route-data';
import type { TabItem } from '../../shared/ui/tab-bar/tab-bar';
import { PcPage } from './pc-page';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota (o título do cabeçalho vem da rota `pc`).
// A Energia mora dentro de "Mais": a aba segue marcada nela.
const TABS: readonly TabItem[] = [
  { link: '/pc', label: $localize`:@@pc.tab.mouse:Mouse` },
  { link: '/pc/atalhos', label: $localize`:@@pc.tab.shortcuts:Atalhos` },
  { link: '/pc/midia', label: $localize`:@@pc.tab.media:Mídia` },
  {
    link: '/pc/mais',
    label: $localize`:@@pc.tab.more:Mais`,
    also: ['/pc/energia', '/pc/controles'],
  },
];

/**
 * A seta única do cabeçalho nos Controles: a lista volta à aba Mais (de onde se chega a ela) e um controle aberto volta à
 * lista. Nenhuma tela dos Controles tem seta própria.
 */
export const REMOTES_LIST_BACK: ShellBack = {
  link: '/pc/mais',
  label: $localize`:@@pc.remotes.back-more:Voltar a Mais`,
};
export const REMOTE_BACK: ShellBack = {
  link: '/pc/controles',
  label: $localize`:@@pc.remotes.back-list:Voltar aos Controles`,
};

/**
 * Rotas do módulo. A casca (`PcPage`) mostra o estado do PC e, quando ele está conectado, a aba aberta. Cada aba é uma
 * página preguiçosa. O endereço antigo do teclado segue valendo e leva à tela do mouse, com o teclado pedido.
 */
export const PC_ROUTES: Routes = [
  {
    path: '',
    component: PcPage,
    data: { tabs: TABS },
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./pages/mouse.page').then((m) => m.MousePage),
      },
      {
        path: 'teclado',
        redirectTo: () => inject(Router).createUrlTree(['/pc'], { queryParams: { teclado: 1 } }),
      },
      {
        path: 'atalhos',
        loadComponent: () => import('./pages/shortcuts.page').then((m) => m.ShortcutsPage),
      },
      {
        path: 'midia',
        loadComponent: () => import('./pages/media.page').then((m) => m.MediaPage),
      },
      {
        path: 'mais',
        loadComponent: () => import('./pages/more.page').then((m) => m.MorePage),
      },
      {
        path: 'energia',
        loadComponent: () => import('./pages/power.page').then((m) => m.PowerPage),
      },
      {
        path: 'controles',
        data: { back: REMOTES_LIST_BACK },
        loadComponent: () => import('./pages/remotes.page').then((m) => m.RemotesPage),
      },
      {
        path: 'controles/:app',
        data: { back: REMOTE_BACK },
        loadComponent: () => import('./pages/remotes.page').then((m) => m.RemotePage),
      },
    ],
  },
];
