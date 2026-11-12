import { InjectionToken } from '@angular/core';
import Dexie, { type DexieOptions, type Table } from 'dexie';
import { accountDatabaseName } from '../../core/session/account-id';
import type { Entity, EntityType, PendingOperation } from './shopping-model';

/** Um registro do retrato do servidor, como ficou guardado no aparelho. */
export interface StoredEntity {
  readonly type: EntityType;
  readonly id: string;
  readonly payload: Entity;
}

export interface StoredMeta {
  readonly key: 'cursor' | 'groupId';
  readonly value: number | string;
}

const SHOPPING_DB_NAME = 'uniover-shopping';

/** Nome do banco de Compras de uma conta: `uniover-shopping-<id>`. */
export function shoppingDbName(accountId: string): string {
  return accountDatabaseName(SHOPPING_DB_NAME, accountId);
}

/**
 * Banco local de Compras de UMA conta (IndexedDB, via Dexie): a fila de escritas ainda não confirmadas, o retrato do
 * que o servidor já confirmou e o cursor do feed. Duas pessoas no mesmo navegador nunca veem a lista uma da outra.
 *
 * REGRA DE ESQUEMA: mudança de esquema = bloco `version(n)` NOVO. Nunca edite um bloco antigo.
 */
export class ShoppingDb extends Dexie {
  /** A fila, na ordem de gravação (`seq` cresce sozinho); `id` é o UUID da operação e não se repete. */
  declare operations: Table<PendingOperation, number>;
  declare entities: Table<StoredEntity, [EntityType, string]>;
  declare meta: Table<StoredMeta, string>;

  constructor(name: string, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      operations: '++seq, &id',
      entities: '[type+id]',
      meta: 'key',
    });
  }
}

/** Abre o banco de uma conta. O teste troca por um IndexedDB em memória. */
export const SHOPPING_DB_FACTORY = new InjectionToken<(accountId: string) => ShoppingDb>(
  'SHOPPING_DB_FACTORY',
  { providedIn: 'root', factory: () => (accountId) => new ShoppingDb(shoppingDbName(accountId)) },
);
