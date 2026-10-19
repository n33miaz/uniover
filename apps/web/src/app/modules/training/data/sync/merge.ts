/**
 * Fusão do que veio do servidor com o que está no aparelho. Funções puras: não leem nem gravam nada, para o teste
 * cobrir as regras sem banco.
 *
 * Regras (convenção do módulo):
 * - por id, vale o `clientUpdatedAt` mais novo; no empate vale o servidor (o puxar só roda com a fila vazia, então
 *   o servidor já viu tudo o que este aparelho mandou);
 * - a lápide é uma linha como as outras: lápide mais nova vence edição mais velha, e edição mais nova vence lápide
 *   mais velha (a mesma regra do servidor);
 * - **linha local nunca é apagada por não ter vindo no puxar**: ela pode ser uma escrita ainda não enviada. Quem
 *   apaga é a lápide, que chega como linha. Por isso esta função só devolve linhas a gravar, nunca ids a remover.
 */

export interface Mergeable {
  readonly id: string;
  /** Instante (ms) em que o aparelho de origem escreveu o registro. */
  readonly clientUpdatedAt: number;
}

/** Escolhe a linha que fica entre a local e a remota. Pode devolver uma terceira, composta das duas. */
export type Resolve<T extends Mergeable> = (local: T, remote: T) => T;

/** Padrão: o `clientUpdatedAt` mais novo; empate vale o remoto. */
export function newestWins<T extends Mergeable>(local: T, remote: T): T {
  return remote.clientUpdatedAt >= local.clientUpdatedAt ? remote : local;
}

/**
 * Linhas que precisam ser gravadas para o banco local refletir a fusão. A linha local que venceu (a mesma
 * referência devolvida por `resolve`) não entra: não há o que regravar. Se o mesmo id aparece duas vezes no lote, a
 * segunda ocorrência é fundida com o resultado da primeira.
 */
export function mergeById<T extends Mergeable>(
  local: ReadonlyMap<string, T>,
  remote: readonly T[],
  resolve: Resolve<T> = newestWins,
): T[] {
  const current = new Map(local);
  const written = new Map<string, T>();

  for (const incoming of remote) {
    const existing = current.get(incoming.id);
    const merged = existing === undefined ? incoming : resolve(existing, incoming);
    if (merged === existing) continue;
    current.set(incoming.id, merged);
    written.set(incoming.id, merged);
  }

  return [...written.values()];
}
