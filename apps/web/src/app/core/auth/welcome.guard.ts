import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { SessionState } from '../session/session-state';
import { AuthService } from './auth.service';

/**
 * Antes de qualquer tela do app, quem entrou e ainda não escolheu o próprio nome vai para `/boas-vindas`, guardando o
 * destino original (com a query) em `next` para voltar a ele ao salvar. Vale para todo mundo, inclusive a convidada que
 * cairia direto no controle da TV.
 *
 * Só barra quando o servidor disse que o nome não foi confirmado (`displayNameConfirmed === false`). Sem usuário
 * carregado (sem rede, servidor dormindo) a pessoa passa: falha de rede nunca a prende, e a pergunta vem na próxima vez.
 * Também não há laço: a tela de boas-vindas fica fora da casca (e deste guarda), e o destino nunca é ela nem o login.
 */
export const welcomeGuard: CanMatchFn = async (_route, segments) => {
  // O contexto de injeção só existe até o primeiro await: tudo é obtido antes.
  const auth = inject(AuthService);
  const session = inject(SessionState);
  const router = inject(Router);
  // O endereço completo (com a query) só está acessível enquanto a navegação corre, ou seja, antes do primeiro await.
  const pending = router.getCurrentNavigation()?.extractedUrl;
  const target = pending
    ? router.serializeUrl(pending)
    : '/' + segments.map((segment) => segment.path).join('/');

  await auth.init();
  await auth.ensureUser();
  return session.needsWelcome() ? auth.welcomeUrlTree(target) : true;
};
