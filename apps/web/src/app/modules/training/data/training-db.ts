import { InjectionToken } from '@angular/core';
import Dexie, { type DexieOptions, type EntityTable } from 'dexie';
import type { LocalExercise } from './catalog/exercise';
import type { LocalRoutine } from './routines/routine';

/**
 * Banco local do Treino (IndexedDB, via Dexie). É outro banco que o da fila de escrita (`uniover-offline`): a fila
 * pode ser esvaziada ou migrada sem tocar nos dados do módulo, e vice-versa.
 *
 * REGRA DE ESQUEMA: mudança de esquema = bloco `version(n)` NOVO. Nunca edite um bloco antigo: o navegador só sabe
 * migrar de uma versão que ele conheceu para a seguinte, e um bloco editado deixa o aparelho que já abriu a versão
 * antiga com um esquema que o código não descreve mais. Cada tarefa que precisa de tabela ou índice novo acrescenta
 * o seu `version(n)` abaixo do último, repetindo só o que muda (o Dexie herda o resto das versões anteriores).
 */

export const TRAINING_DB_NAME = 'uniover-training';

/**
 * Esquema da versão 1, exportado só para o teste de migração abrir o banco exatamente como o aparelho o deixou.
 * `deletedAt` entra no índice, mas linha com `deletedAt: null` não aparece nele (null não é chave do IndexedDB):
 * as leituras filtram a lápide em memória e usam o índice só como atalho para o que tem valor.
 */
export const TRAINING_SCHEMA_V1 = {
  exercises: 'id, slug, *primaryMuscles, equipment, nameKey, deletedAt',
  meta: 'key',
  syncState: 'resource',
} as const;

/**
 * Esquema da versão 2: a tabela das rotinas (a rotina com os itens dentro). `active` não entra no índice: booleano não
 * é chave do IndexedDB, e a lista de rotinas ativas filtra em memória (são poucas). O bloco da versão 1 não foi tocado.
 */
export const TRAINING_SCHEMA_V2 = {
  routines: 'id, position, updatedAt, deletedAt',
} as const;

export interface TrainingMetaRow {
  readonly key: string;
  readonly value: unknown;
}

/** Onde o puxador parou em cada recurso. */
export interface SyncStateRow {
  readonly resource: string;
  /** Último cursor entregue pelo servidor (texto opaco), ou `null` se o recurso nunca foi puxado. */
  readonly cursor: string | null;
  /** Instante (ms) do último puxar que terminou sem erro. */
  readonly lastPullAt: number | null;
}

export class TrainingDb extends Dexie {
  declare exercises: EntityTable<LocalExercise, 'id'>;
  declare meta: EntityTable<TrainingMetaRow, 'key'>;
  declare syncState: EntityTable<SyncStateRow, 'resource'>;
  declare routines: EntityTable<LocalRoutine, 'id'>;

  constructor(name: string = TRAINING_DB_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores(TRAINING_SCHEMA_V1);
    this.version(2).stores(TRAINING_SCHEMA_V2);
  }
}

export const TRAINING_DB = new InjectionToken<TrainingDb>('TRAINING_DB', {
  providedIn: 'root',
  factory: () => new TrainingDb(),
});
