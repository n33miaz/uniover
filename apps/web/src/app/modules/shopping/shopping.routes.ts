import { Routes } from '@angular/router';

export const SHOPPING_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./shopping.page').then((m) => m.ShoppingPage),
  },
];
