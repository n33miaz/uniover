import { Routes } from '@angular/router';

export const TV_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./tv-page').then((m) => m.TvPage) },
];
