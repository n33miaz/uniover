import { Routes } from '@angular/router';

// Cada módulo de tela é uma rota preguiçosa.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadChildren: () => import('./modules/home/home.routes').then((m) => m.HOME_ROUTES),
  },
  {
    path: 'tv',
    loadChildren: () => import('./modules/tv/tv.routes').then((m) => m.TV_ROUTES),
  },
  {
    path: 'treino',
    loadChildren: () => import('./modules/training/training.routes').then((m) => m.TRAINING_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
