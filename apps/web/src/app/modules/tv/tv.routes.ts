import { Routes } from '@angular/router';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota. O `title` vazio liga o "cabeçalho
// próprio": o módulo desenha o dele (Início, nome com a bolinha de estado e energia) e a casca não repete o seu.
export const TV_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./tv-page').then((m) => m.TvPage),
    data: {
      title: '',
      tabs: [
        { link: '/tv', label: $localize`:@@tv.tab.control:Controle` },
        { link: '/tv/apps', label: $localize`:@@tv.tab.apps:Apps` },
        { link: '/tv/teclado', label: $localize`:@@tv.tab.keyboard:Teclado` },
      ],
    },
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./pages/control.page').then((m) => m.ControlPage),
      },
      {
        path: 'apps',
        loadComponent: () => import('./pages/apps.page').then((m) => m.AppsPage),
      },
      {
        path: 'teclado',
        loadComponent: () => import('./pages/keyboard.page').then((m) => m.KeyboardPage),
      },
    ],
  },
];
