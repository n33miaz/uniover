import { inject } from '@angular/core';
import { CanMatchFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Protege as telas do app. Espera a primeira confirmação da sessão (limitada no tempo) e decide:
 * `anonymous` → tela de entrada (com `next` seguro); `pending` e `authenticated` → deixa passar. Sessão pendente
 * (sem rede, servidor dormindo) abre a casca com aviso e **não** manda para o login: o app serve offline.
 */
export const authGuard: CanMatchFn = async (_route, segments) => {
  const auth = inject(AuthService);
  await auth.init();
  if (auth.status() !== 'anonymous') return true;
  return auth.loginUrlTree('/' + segments.map((segment) => segment.path).join('/'));
};
