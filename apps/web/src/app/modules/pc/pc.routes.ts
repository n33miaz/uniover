import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import type { ShellBack } from '../../core/layout/route-data';
import type { TabItem } from '../../shared/ui/tab-bar/tab-bar';
import { PcAvailability } from '../../core/modules/pc-availability';
import { PcScreenAccess } from './data/screen-access';
import { PcPage } from './pc-page';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota (o título do cabeçalho vem da rota `pc`).
// A Energia e a área de transferência moram dentro de "Mais": a aba segue marcada nelas.
const TABS: readonly TabItem[] = [
  { link: '/pc', label: $localize`:@@pc.tab.mouse:Mouse`, icon: 'mouse' },
  { link: '/pc/atalhos', label: $localize`:@@pc.tab.shortcuts:Atalhos`, icon: 'shortcuts' },
  { link: '/pc/midia', label: $localize`:@@pc.tab.media:Mídia`, icon: 'media' },
  {
    link: '/pc/mais',
    label: $localize`:@@pc.tab.more:Mais`,
    icon: 'more',
    also: ['/pc/energia', '/pc/controles', '/pc/area-de-transferencia', '/pc/tela'],
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
 * A tela do PC fica atrás do `pc_screen` e do `pc:screen`: sem eles a rota volta ao mouse. Num endereço aberto direto
 * (recarga ou link) o PC ainda não declarou as capacidades; a decisão espera a primeira leitura.
 */
export const screenGuard: CanActivateFn = async () => {
  const availability = inject(PcAvailability);
  const access = inject(PcScreenAccess);
  const router = inject(Router);
  if (availability.status() === null) await availability.refresh();
  return access.allowed() || router.createUrlTree(['/pc']);
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
        path: 'tela',
        canActivate: [screenGuard],
        data: { back: REMOTES_LIST_BACK },
        loadComponent: () => import('./pages/screen.page').then((m) => m.ScreenPage),
      },
      {
        path: 'energia',
        loadComponent: () => import('./pages/power.page').then((m) => m.PowerPage),
      },
      {
        path: 'area-de-transferencia',
        loadComponent: () => import('./pages/clipboard.page').then((m) => m.ClipboardPage),
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
