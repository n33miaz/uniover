import type { RoutineItemModel, RoutineModel } from './routine-model';

/** Peças de teste do domínio das rotinas. Só os testes importam este arquivo; nada daqui entra no bundle do app. */

/** Item com valores razoáveis; o teste sobrescreve só o que importa. */
export function item(
  id: string,
  position: number,
  overrides: Partial<RoutineItemModel> = {},
): RoutineItemModel {
  return {
    id,
    exerciseId: `ex-${id}`,
    position,
    targetSets: 3,
    repMin: 8,
    repMax: 12,
    restSeconds: 90,
    supersetGroup: null,
    note: '',
    ...overrides,
  };
}

/** Itens a, b, c... nas posições 0, 1, 2... com os grupos de supersérie pedidos (`null` = sem grupo). */
export function items(groups: readonly (number | null)[]): RoutineItemModel[] {
  return groups.map((supersetGroup, index) =>
    item(String.fromCharCode(97 + index), index, { supersetGroup }),
  );
}

export function routine(overrides: Partial<RoutineModel> = {}): RoutineModel {
  return {
    id: 'r1',
    name: 'A',
    position: 0,
    active: true,
    note: '',
    items: [item('a', 0)],
    ...overrides,
  };
}

/** Os ids e grupos da lista, na ordem, para o teste comparar de uma vez. */
export function shape(list: readonly RoutineItemModel[]): [string, number | null][] {
  return list.map((entry) => [entry.id, entry.supersetGroup]);
}
