import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { SessionState } from '../session/session-state';
import { AuthService } from './auth.service';

/** Onde o convidado vive: o controle da TV é a tela principal dele (os Ajustes dele saem de lá pelo botão redondo). */
export const GUEST_HOME = '/tv';

/**
 * Fecha para o convidado as telas que são só do dono (Início, Treino, e em Ajustes: Segurança, Pessoas, Aparelhos e
 * Créditos): ele é levado ao controle da TV. Só barra quando se SABE que é convidado; papel ainda desconhecido
 * (sessão a confirmar, sem rede) deixa passar, para nunca trancar o dono para fora. Esconder não é segurança: a API
 * recusa com 403 de qualquer jeito.
 */
export const ownerOnlyGuard: CanMatchFn = async () => {
  // O contexto de injeção só existe até o primeiro await: tudo é obtido antes.
  const auth = inject(AuthService);
  const session = inject(SessionState);
  const router = inject(Router);
  await auth.init();
  return session.isGuest() ? router.createUrlTree([GUEST_HOME]) : true;
};
