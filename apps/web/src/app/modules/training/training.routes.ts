import { Routes } from '@angular/router';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota.
export const TRAINING_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./training-page').then((m) => m.TrainingPage),
    data: { tabs: [{ link: '/treino', label: $localize`:@@training.tab.today:Treino` }] },
  },
];
