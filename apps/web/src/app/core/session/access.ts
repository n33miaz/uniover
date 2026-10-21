import { SessionUser } from './session-state';

/**
 * Se a conta pode fazer o que `permission` nomeia, pela lista que a API manda em `/me` (a mesma que ela aplica nas
 * rotas). Serve para a tela não mostrar o que o servidor recusaria; quem decide de verdade continua sendo a API.
 *
 * Só esconde o que se SABE que a pessoa não pode, a mesma regra do guarda de papel (nunca trancar o dono para fora):
 * - o dono pode tudo (a API já manda a lista inteira, mas aqui não depende dela);
 * - sem usuário carregado (sem rede, servidor acordando) ou numa resposta sem a lista, não se sabe: vale como permitido,
 *   e a tela se ajusta sozinha quando a sessão trouxer a lista (as permissões são um signal);
 * - o convidado com a lista só pode o que ela traz.
 */
export function userCan(user: SessionUser | null, permission: string): boolean {
  if (!user || user.permissions === undefined) return true;
  if (user.role !== 'guest') return true;
  return user.permissions.includes(permission);
}
