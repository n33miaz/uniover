import type { AccountRole } from '../session/session-state';

/** Quem não tem módulo nenhum: uma tela simples, com Perfil e Sair (nunca um módulo que a pessoa não pode usar). */
export const NO_ACCESS_PATH = '/sem-acesso';

/**
 * Para onde vai o convidado quando não se sabe o que ele pode (sem rede e sem dica da última sessão, ou resposta antiga
 * sem a lista): o controle da TV, como sempre foi. Quem decide de verdade é a API, com 403.
 */
export const UNKNOWN_GUEST_HOME = '/tv';

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
 * A tela inicial de quem não tem o Início: o primeiro módulo que ele pode usar, na ordem do registro de módulos (a TV
 * antes do Treino). Sem nenhum, a tela de "sem acesso". Sem a lista (`null`), o controle da TV. O dono tem o Início (`/`).
 *
 * Nunca devolve um módulo que a pessoa não pode usar, então o redirecionamento não cai num guarda que a manda de volta.
 */
export function homeFor(
  role: AccountRole | null,
  permissions: readonly string[] | null,
  modules: readonly HomeModule[],
): string {
  if (role !== 'guest') return '/';
  if (permissions === null) return UNKNOWN_GUEST_HOME;
  const first = modules.find(
    (module) => module.slug !== undefined && permissions.includes(modulePermission(module.id)),
  );
  return first ? `/${first.slug}` : NO_ACCESS_PATH;
}
