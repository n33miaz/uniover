import { Routes } from '@angular/router';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota.
export const TV_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./tv-page').then((m) => m.TvPage),
    data: { tabs: [{ link: '/tv', label: $localize`:@@tv.tab.control:Controle` }] },
  },
];
