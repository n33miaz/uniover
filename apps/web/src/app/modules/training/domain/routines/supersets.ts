import type { RoutineItemModel } from './routine-model';

/**
 * Ordem dos itens e superséries. Supersérie = itens **vizinhos** com o mesmo `supersetGroup`; o descanso só vem depois
 * do grupo. Todas as funções devolvem listas novas e nunca alteram a entrada.
 */

/** Ordena pela posição (empate: ordem em que vieram) e recompacta em 0, 1, 2... Mesma regra do servidor. */
export function compactPositions<T extends { readonly position: number }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.position - b.item.position || a.index - b.index)
    .map(({ item }, position) => (item.position === position ? item : { ...item, position }));
}

/**
 * As superséries da lista: cada uma é uma sequência de dois ou mais itens vizinhos com o mesmo grupo. A lista deve
 * estar na ordem de exibição (use `compactPositions`).
 */
export function supersetGroups(items: readonly RoutineItemModel[]): RoutineItemModel[][] {
  const groups: RoutineItemModel[][] = [];
  let run: RoutineItemModel[] = [];
  for (const item of items) {
    if (
      run.length > 0 &&
      item.supersetGroup !== null &&
      item.supersetGroup === run[0].supersetGroup
    )
      run.push(item);
    else {
      if (run.length > 1) groups.push(run);
      run = item.supersetGroup === null ? [] : [item];
    }
  }
  if (run.length > 1) groups.push(run);
  return groups;
}

/** `links[i]` é verdadeiro quando o item `i` está junto com o item seguinte (mesmo grupo, ambos com grupo). */
export function supersetLinks(items: readonly RoutineItemModel[]): boolean[] {
  return items.map((item, index) => {
    const next = items[index + 1];
    return (
      next !== undefined && item.supersetGroup !== null && item.supersetGroup === next.supersetGroup
    );
  });
}

/** Reescreve os grupos a partir dos vínculos: cada sequência ligada vira o grupo 1, 2, 3..., e item sozinho fica sem grupo. */
function applyLinks(
  items: readonly RoutineItemModel[],
  links: readonly boolean[],
): RoutineItemModel[] {
  const result: RoutineItemModel[] = [];
  let group = 0;
  let runStart = 0;
  for (let index = 0; index < items.length; index++) {
    const linkedToNext = links[index] === true;
    if (!linkedToNext) {
      const size = index - runStart + 1;
      if (size > 1) group++;
      for (let at = runStart; at <= index; at++) {
        const supersetGroup = size > 1 ? group : null;
        const item = items[at];
        result.push(item.supersetGroup === supersetGroup ? item : { ...item, supersetGroup });
      }
      runStart = index + 1;
    }
  }
  return result;
}

/**
 * Deixa as superséries no formato que o servidor guarda: um grupo com um item só vira "sem supersérie", e o mesmo
 * número que reaparece depois de outro item no meio vira outro grupo. Os números são refeitos em 1, 2, 3...
 */
export function normalizeSupersets(items: readonly RoutineItemModel[]): RoutineItemModel[] {
  return applyLinks(items, supersetLinks(items));
}

/** Ordena, recompacta as posições e normaliza as superséries: a forma única em que a rotina é gravada e enviada. */
export function normalizeItems(items: readonly RoutineItemModel[]): RoutineItemModel[] {
  return normalizeSupersets(compactPositions(items));
}

/**
 * "Juntar com o próximo": liga ou desliga o item de `index` ao item seguinte. Sem item seguinte (o último) não
 * muda nada. Devolve a lista já normalizada.
 */
export function toggleSupersetWithNext(
  items: readonly RoutineItemModel[],
  index: number,
): RoutineItemModel[] {
  const ordered = compactPositions(items);
  if (index < 0 || index >= ordered.length - 1) return normalizeSupersets(ordered);
  const links = supersetLinks(ordered);
  links[index] = !links[index];
  return applyLinks(ordered, links);
}

/**
 * Move o item `itemId` para o índice `toIndex` (0 a n - 1; fora disso é limitado às pontas). Se ele sai da supersérie
 * em que estava, fica sem grupo; se cai no meio de uma supersérie, entra nela. Devolve a lista normalizada, ou a
 * mesma ordem quando o item não existe.
 */
export function moveItem(
  items: readonly RoutineItemModel[],
  itemId: string,
  toIndex: number,
): RoutineItemModel[] {
  const ordered = compactPositions(items);
  const from = ordered.findIndex((item) => item.id === itemId);
  if (from < 0) return normalizeSupersets(ordered);

  const target = Math.max(0, Math.min(ordered.length - 1, Math.trunc(toIndex)));
  const moved = ordered[from];
  const rest = ordered.filter((_, index) => index !== from);
  const placed = [...rest.slice(0, target), moved, ...rest.slice(target)];

  const before = placed[target - 1];
  const after = placed[target + 1];
  let group = moved.supersetGroup;
  if (before?.supersetGroup != null && before.supersetGroup === after?.supersetGroup) {
    // Caiu entre dois itens da mesma supersérie: entra nela.
    group = before.supersetGroup;
  } else if (group !== null && before?.supersetGroup !== group && after?.supersetGroup !== group) {
    // Ficou longe do grupo que tinha: sai dele.
    group = null;
  }

  placed[target] = group === moved.supersetGroup ? moved : { ...moved, supersetGroup: group };
  return normalizeItems(placed.map((item, position) => ({ ...item, position })));
}
