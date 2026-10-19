/**
 * Modelo e limites da rotina (ficha) do Treino. Funções e tipos puros: nada de Angular, banco ou rede. Os limites são
 * os mesmos da API, para o que ela recusaria nem entrar na fila de escrita.
 */

export const ROUTINE_LIMITS = {
  nameMax: 80,
  noteMax: 500,
  itemNoteMax: 300,
  maxItems: 40,
  positionMax: 1000,
  setsMin: 1,
  setsMax: 20,
  repsMin: 1,
  repsMax: 100,
  restMax: 1800,
  supersetGroupMin: 1,
  supersetGroupMax: 100,
} as const;

/** Meta de um exercício recém-adicionado a uma rotina. É proposta nossa, e o dono edita. */
export const NEW_ITEM_DEFAULTS = {
  targetSets: 3,
  repMin: 8,
  repMax: 12,
  restSeconds: 90,
} as const;

/** Um exercício dentro da rotina, com a meta dele. Itens vizinhos com o mesmo `supersetGroup` formam uma supersérie. */
export interface RoutineItemModel {
  readonly id: string;
  readonly exerciseId: string;
  /** Ordem na rotina, de 0 em diante e sem lacuna (ver `compactPositions`). */
  readonly position: number;
  readonly targetSets: number;
  readonly repMin: number;
  readonly repMax: number;
  /** Descanso em segundos; numa supersérie só vale o do último item do grupo. */
  readonly restSeconds: number;
  readonly supersetGroup: number | null;
  /** Vazio quando não há anotação. */
  readonly note: string;
}

/** Uma rotina como o editor a enxerga: cabeçalho e itens juntos. */
export interface RoutineModel {
  readonly id: string;
  readonly name: string;
  /** Ordem da rotina na sequência (A, B, C...). */
  readonly position: number;
  /** Rotina inativa continua guardada, mas fica fora da sequência. */
  readonly active: boolean;
  /** Vazio quando não há anotação. */
  readonly note: string;
  readonly items: readonly RoutineItemModel[];
}
