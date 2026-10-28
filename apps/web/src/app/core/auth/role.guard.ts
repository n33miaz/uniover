import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { SessionState } from '../session/session-state';
import { AuthService } from './auth.service';
import { canUseModule, homeFor } from './guest-home';

/**
 * Toda conta volta à Início; nela cada convidado vê apenas os módulos liberados para a conta.
 */
export function guestHome(): string {
  return homeFor();
}

/**
 * Fecha para o convidado as telas que são só do dono (em Configurações: Pessoas, Auditoria e Sistema): ele é levado à Início.
 * Só barra quando se SABE que é convidado; papel ainda desconhecido (sessão a confirmar,
 * sem rede) deixa passar, para nunca trancar o dono para fora. Esconder não é segurança: a API recusa com 403 de qualquer
 * jeito.
 */
export const ownerOnlyGuard: CanMatchFn = async () => {
  // O contexto de injeção só existe até o primeiro await: tudo é obtido antes.
  const auth = inject(AuthService);
  const session = inject(SessionState);
  const router = inject(Router);
  await auth.init();
  return session.isGuest() ? router.createUrlTree([guestHome()]) : true;
};

/**
 * Deixa entrar quem pode usar o módulo (`id` do catálogo: `tv`, `training`): o dono sempre, o convidado se a lista dele
 * traz `module:<id>`. Quem não pode vai ao primeiro módulo que pode usar, e nunca ao próprio módulo barrado (sem laço).
 * Sem a lista (sem rede, sessão a confirmar, sem dica da última sessão) deixa passar: a rede ruim da academia não pode
 * trancar o Treino, e a API recusa o que não é da conta.
 */
export function moduleGuard(id: string): CanMatchFn {
  return async () => {
    const auth = inject(AuthService);
    const session = inject(SessionState);
    const router = inject(Router);
    await auth.init();
    if (canUseModule(session.role(), session.knownPermissions(), id)) return true;
    return router.createUrlTree([guestHome()]);
  };
}
