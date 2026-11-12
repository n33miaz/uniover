import { Routes } from '@angular/router';
import { ShoppingScope } from './shopping-scope';

/** A seta das telas filhas volta à entrada do módulo. */
const BACK = {
  link: '/compras',
  label: $localize`:@@shopping.back-label:Voltar às Compras`,
};

/**
 * Compras: a entrada (três caminhos e o acesso a Detalhes) e uma tela por caminho. `ShoppingScope` fica em volta de
 * todas: é ele que abre as Compras da conta, uma vez por visita ao módulo.
 */
export const SHOPPING_ROUTES: Routes = [
  {
    path: '',
    component: ShoppingScope,
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./shopping-hub.page').then((m) => m.ShoppingHubPage),
      },
      {
        path: 'lista',
        data: { title: $localize`:@@shopping.list.title:Lista`, back: BACK },
        loadComponent: () => import('./shopping-list.page').then((m) => m.ShoppingListPage),
      },
      {
        path: 'mercado',
        data: { title: $localize`:@@shopping.market.title:Mercado Agora`, back: BACK },
        loadComponent: () => import('./shopping-market.page').then((m) => m.ShoppingMarketPage),
      },
      {
        path: 'historico',
        data: { title: $localize`:@@shopping.history.title:Histórico`, back: BACK },
        loadComponent: () => import('./shopping-history.page').then((m) => m.ShoppingHistoryPage),
      },
      {
        path: 'detalhes',
        data: { title: $localize`:@@shopping.details.title:Detalhes`, back: BACK },
        loadComponent: () => import('./shopping-details.page').then((m) => m.ShoppingDetailsPage),
      },
    ],
  },
];
