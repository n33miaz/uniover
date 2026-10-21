import { TvShortcut } from './tv-types';

/**
 * Lugar de um atalho na fileira do controle: `index` de 0 a `count - 1`. Conta só os que estão no controle (os que a
 * fileira mostra), na ordem da lista; quem não está lá não tem lugar (a ordem dele não aparece em lugar nenhum).
 */
export interface ControlRank {
  readonly index: number;
  readonly count: number;
}

export function controlRanks(list: readonly TvShortcut[]): Map<string, ControlRank> {
  const pinned = list.filter((item) => item.enabled);
  return new Map(pinned.map((item, index) => [item.id, { index, count: pinned.length }]));
}

/**
 * A ordem de TODOS os atalhos (ids) que sai de mover `id` um passo entre os que estão no controle, ou `null` se ele
 * já está na ponta (ou não está no controle). A API recebe a lista inteira, inclusive o que a fileira não mostra, e
 * exige que ela seja uma permutação exata: por isso a conta é feita sobre a lista completa, não sobre o que o painel
 * exibe. Quem não está no controle (fora dele ou desinstalado) fica exatamente onde estava; o atalho que se move
 * troca de lugar com o vizinho do controle, então a ordem relativa de todos os outros não muda.
 */
export function movedOrder(
  list: readonly TvShortcut[],
  id: string,
  delta: -1 | 1,
): string[] | null {
  const slots: number[] = [];
  list.forEach((item, index) => {
    if (item.enabled) slots.push(index);
  });
  const from = slots.findIndex((slot) => list[slot].id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= slots.length) return null;

  const ids = list.map((item) => item.id);
  [ids[slots[from]], ids[slots[to]]] = [ids[slots[to]], ids[slots[from]]];
  return ids;
}

/** A lista como fica na ordem de `ids`, com as posições renumeradas de 1 a n; `null` se `ids` não for uma permutação dela. */
export function withOrder(
  list: readonly TvShortcut[],
  ids: readonly string[],
): TvShortcut[] | null {
  if (ids.length !== list.length) return null;
  const byId = new Map(list.map((item) => [item.id, item]));
  const ordered: TvShortcut[] = [];
  for (const [index, id] of ids.entries()) {
    const item = byId.get(id);
    if (!item) return null;
    byId.delete(id);
    ordered.push({ ...item, position: index + 1 });
  }
  return ordered;
}
