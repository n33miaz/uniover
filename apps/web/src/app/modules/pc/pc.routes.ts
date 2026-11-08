import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import type { TabItem } from '../../shared/ui/tab-bar/tab-bar';
import { PcPage } from './pc-page';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota (o título do cabeçalho vem da rota `pc`).
// A Energia mora dentro de "Mais": a aba segue marcada nela.
const TABS: readonly TabItem[] = [
  { link: '/pc', label: $localize`:@@pc.tab.mouse:Mouse` },
  { link: '/pc/atalhos', label: $localize`:@@pc.tab.shortcuts:Atalhos` },
  { link: '/pc/midia', label: $localize`:@@pc.tab.media:Mídia` },
  { link: '/pc/mais', label: $localize`:@@pc.tab.more:Mais`, also: ['/pc/energia'] },
];

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
        loadComponent: () => import('./pages/keyboard.page').then((m) => m.KeyboardPage),
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
    ],
  },
];
