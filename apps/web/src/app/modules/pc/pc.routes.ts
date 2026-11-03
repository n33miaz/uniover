import { Routes } from '@angular/router';
import type { TabItem } from '../../shared/ui/tab-bar/tab-bar';
import { PcPage } from './pc-page';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota (o título do cabeçalho vem da rota `pc`).
const TABS: readonly TabItem[] = [
  { link: '/pc', label: $localize`:@@pc.tab.touchpad:Touchpad` },
  { link: '/pc/teclado', label: $localize`:@@pc.tab.keyboard:Teclado` },
  { link: '/pc/midia', label: $localize`:@@pc.tab.media:Mídia` },
  { link: '/pc/energia', label: $localize`:@@pc.tab.power:Energia` },
];

/**
 * Rotas do módulo. A casca (`PcPage`) mostra o estado do PC e, quando ele está conectado, a aba aberta. Cada aba é uma
 * página preguiçosa.
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
        loadComponent: () => import('./pages/touchpad.page').then((m) => m.TouchpadPage),
      },
      {
        path: 'teclado',
        loadComponent: () => import('./pages/keyboard.page').then((m) => m.KeyboardPage),
      },
      {
        path: 'midia',
        loadComponent: () => import('./pages/media.page').then((m) => m.MediaPage),
      },
      {
        path: 'energia',
        loadComponent: () => import('./pages/power.page').then((m) => m.PowerPage),
      },
    ],
  },
];
