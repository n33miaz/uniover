import type { AccountRole } from '../session/session-state';

/** Quem não tem módulo nenhum: uma tela simples, com Perfil e Sair (nunca um módulo que a pessoa não pode usar). */
export const NO_ACCESS_PATH = '/sem-acesso';

/** A Início é a entrada de toda conta, inclusive quando a lista de permissões ainda não chegou. */
export const UNKNOWN_GUEST_HOME = '/';

/** O que o guarda precisa saber de um módulo: o `id` do catálogo (a permissão é `module:<id>`) e o caminho da tela. */
export interface HomeModule {
  readonly id: string;
  readonly slug?: string;
}

/** A permissão que libera um módulo, no catálogo da API (`module:tv`, `module:training`). */
export function modulePermission(id: string): string {
  return `module:${id}`;
}

/**
 * Se a pessoa pode abrir o módulo. O dono pode tudo. O convidado só o que a lista dele traz; sem lista (`null`: não se
 * sabe) vale como permitido, a mesma regra do guarda de papel: a falta de rede nunca tranca ninguém para fora, e a API
 * recusa o que não é da conta.
 *
 * Repete, de propósito, a regra de `userCan` (acesso por permissão dentro da TV) para não depender de outro arquivo: se
 * a regra mudar, muda nos dois.
 */
export function canUseModule(
  role: AccountRole | null,
  permissions: readonly string[] | null,
  id: string,
): boolean {
  if (role !== 'guest' || permissions === null) return true;
  return permissions.includes(modulePermission(id));
}

/**
 * A Início é a entrada de todo mundo. O catálogo continua no argumento porque as guardas de módulo compartilham esta
 * assinatura, mas a grade filtra cada cartão pela permissão da conta.
 */
export function homeFor(
  role: AccountRole | null,
  permissions: readonly string[] | null,
  modules: readonly HomeModule[],
): string {
  void role;
  void permissions;
  void modules;
  return '/';
}
