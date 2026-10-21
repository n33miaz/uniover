import type { SessionUser } from './session-state';

/**
 * Mesmas permissões, comparadas pelo conteúdo e sem depender da ordem: a API devolve uma lista nova a cada leitura de
 * `/me`, e o que importa para a tela é o conjunto. Ausente e vazia valem o mesmo (resposta antiga, sem a lista).
 */
export function samePermissions(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left === right) return true;
  const unique = new Set(left);
  if (unique.size !== new Set(right).size) return false;
  return right.every((permission) => unique.has(permission));
}

/** Mesma conta, campo a campo (as permissões pelo conteúdo): reler `/me` sem mudança não deve avisar ninguém. */
export function sameUser(a: SessionUser | null, b: SessionUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.role === b.role &&
    a.displayNameConfirmed === b.displayNameConfirmed &&
    samePermissions(a.permissions, b.permissions)
  );
}
