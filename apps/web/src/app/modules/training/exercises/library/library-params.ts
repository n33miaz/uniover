import type { ParamMap, Params } from '@angular/router';
import type { CatalogQuery } from '../../data/catalog/catalog-repository';
import { isEquipmentId, isMuscleGroupId, isMuscleId } from '../../domain/taxonomy';

/**
 * Filtros da lista de exercícios como moram no endereço (`?q=&group=&muscle=&equipment=`). O endereço é o que deixa o
 * mapa do corpo abrir a lista já filtrada e o botão "voltar" trazer a lista como estava. Valor que o app não conhece
 * (um id inventado à mão no endereço) é ignorado, e não vira um filtro que nunca acha nada.
 */
export interface LibraryParams {
  /** Texto da busca, como foi digitado (a normalização é do repositório). */
  readonly q: string;
  /** Id do grupo muscular, ou vazio. */
  readonly group: string;
  /** Id do músculo principal, ou vazio. */
  readonly muscle: string;
  readonly equipment: string;
}

export const EMPTY_LIBRARY_PARAMS: LibraryParams = { q: '', group: '', muscle: '', equipment: '' };

export function parseLibraryParams(map: ParamMap): LibraryParams {
  const group = map.get('group') ?? '';
  const muscle = map.get('muscle') ?? '';
  const equipment = map.get('equipment') ?? '';
  return {
    q: (map.get('q') ?? '').slice(0, 80),
    // Músculo e grupo não se somam na tela: o músculo é o filtro mais fino e, se vier, vale sozinho.
    group: !isMuscleId(muscle) && isMuscleGroupId(group) ? group : '',
    muscle: isMuscleId(muscle) ? muscle : '',
    equipment: isEquipmentId(equipment) ? equipment : '',
  };
}

/** Os parâmetros do endereço; campo vazio vira `null`, que o roteador tira do endereço. */
export function toQueryParams(params: LibraryParams): Params {
  return {
    q: params.q.trim() === '' ? null : params.q,
    group: params.group || null,
    muscle: params.muscle || null,
    equipment: params.equipment || null,
  };
}

/** Chave estável dos filtros, para saber se o endereço que chegou é o que a própria tela acabou de escrever. */
export function paramsKey(params: LibraryParams): string {
  return JSON.stringify([params.q.trim(), params.group, params.muscle, params.equipment]);
}

export function toCatalogQuery(params: LibraryParams): CatalogQuery {
  return {
    text: params.q,
    group: params.group || undefined,
    muscle: params.muscle || undefined,
    equipment: params.equipment || undefined,
  };
}

/** Há algum filtro em vigor (busca, grupo, músculo ou equipamento). */
export function isFiltered(params: LibraryParams): boolean {
  return params.q.trim() !== '' || !!params.group || !!params.muscle || !!params.equipment;
}
