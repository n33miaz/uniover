import { inject } from '@angular/core';
import { Routes, Router } from '@angular/router';
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
  { path: 'apps', redirectTo: toPanel('apps') },
  { path: 'teclado', redirectTo: toPanel('keyboard') },
];
