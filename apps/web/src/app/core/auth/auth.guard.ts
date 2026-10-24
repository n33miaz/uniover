import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Protege as telas do app. Espera a primeira confirmação da sessão (limitada no tempo) e decide:
 * `anonymous` → tela de entrada (com `next` seguro); `pending` e `authenticated` → deixa passar. Sessão pendente
 * (sem rede, servidor dormindo) abre a casca com aviso e **não** manda para o login: o app serve offline.
 *
 * O `next` leva o endereço inteiro, com a query: é assim que o link do QR do agente (`?codigo=`) sobrevive ao login.
 */
export const authGuard: CanMatchFn = async (_route, segments) => {
  // O contexto de injeção só existe até o primeiro await: tudo é obtido antes.
  const auth = inject(AuthService);
  const router = inject(Router);
  // O endereço completo (com a query) só está acessível enquanto a navegação corre, ou seja, antes do primeiro await.
  const pending = router.getCurrentNavigation()?.extractedUrl;
  const target = pending
    ? router.serializeUrl(pending)
    : '/' + segments.map((segment) => segment.path).join('/');

  await auth.init();
  if (auth.status() !== 'anonymous') return true;
  return auth.loginUrlTree(target);
};
