import { inject } from '@angular/core';
import { Routes, Router } from '@angular/router';
import { ownerOnlyGuard } from '../../core/auth/role.guard';
import { TV_PANEL_PARAM, TV_PANEL_VALUES, TvPanelName } from './data/tv-panels';

/** Os endereços antigos de Apps e Teclado levam ao controle com o painel correspondente aberto. */
function toPanel(panel: TvPanelName) {
  return () =>
    inject(Router).createUrlTree(['/tv'], {
      queryParams: { [TV_PANEL_PARAM]: TV_PANEL_VALUES[panel] },
    });
}

// A tela é uma só (sem barra de abas): o `title` vazio liga o "cabeçalho próprio", em que o módulo desenha o dele
// (Início, nome com o ponto de estado e energia) e a casca não repete o seu. Apps e Teclado são painéis
// flutuantes dentro dela.
export const TV_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./tv-page').then((m) => m.TvPage),
    data: { title: '' },
  },
  {
    // O TV Livre (launcher próprio da TV) é só do dono nesta entrega: o guarda leva o convidado à Início, e a API recusa
    // com 403 de qualquer jeito. O título e a seta de volta ao controle são os do shell, pelos dados da rota (como Ajustes).
    path: 'livre',
    canMatch: [ownerOnlyGuard],
    data: {
      title: $localize`:@@tv-livre.route.title:TV Livre`,
      back: { link: '/tv', label: $localize`:@@tv-livre.back-label:Voltar ao Controle` },
    },
    loadComponent: () => import('./livre/livre.page').then((m) => m.LivrePage),
  },
  { path: 'apps', redirectTo: toPanel('apps') },
  { path: 'teclado', redirectTo: toPanel('keyboard') },
];
