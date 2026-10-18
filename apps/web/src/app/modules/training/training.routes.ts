import { Routes } from '@angular/router';

export const TRAINING_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./training-page').then((m) => m.TrainingPage) },
];
