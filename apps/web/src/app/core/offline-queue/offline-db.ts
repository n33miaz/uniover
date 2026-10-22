import { InjectionToken } from '@angular/core';
import Dexie, { type DexieOptions, type EntityTable } from 'dexie';
import { accountDatabaseName } from '../session/account-id';

/**
 * `pending`: espera envio (inclui o que aguarda a próxima tentativa) · `sending`: em voo agora · `failed`: o
 * servidor recusou de forma definitiva; fica visível para o usuário decidir.
 */
export type OutboxStatus = 'pending' | 'sending' | 'failed';

export type OutboxMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OutboxItem {
  /** UUID v7 gerado no aparelho; é também o valor de `Idempotency-Key` em todas as tentativas. */
  readonly id: string;
  readonly method: OutboxMethod;
  /** Caminho relativo da API (`/api/...`). */
  readonly url: string;
  /** Corpo JSON (dado do usuário; nunca credencial). `undefined` para pedidos sem corpo. */
  readonly body: unknown;
  /** Módulo dono do item (só para organização e exibição). */
  readonly module: string;
  /** Instante (ms) da gravação: define a ordem de envio. */
  readonly createdAt: number;
  /** Quantas vezes o envio já foi tentado. */
  readonly attempts: number;
  /** Antes deste instante (ms) o motor não tenta de novo (espera do backoff). */
  readonly nextAttemptAt: number;
  readonly status: OutboxStatus;
  readonly lastError: string | null;
  /**
   * Sobe a cada mudança feita por quem usa a fila (editar, tentar de novo). O motor só dá o item por enviado se a
   * revisão que mandou ainda for a mesma quando a resposta chega.
   */
  readonly revision: number;
}

export interface MetaRow {
  readonly key: string;
  readonly value: unknown;
}

/**
 * Nome do banco do tempo em que havia um só por aparelho (hoje só é lido para a adoção, ver `legacy-adoption.ts`). O banco
 * em uso leva o id da conta no nome (`offlineDbName`).
 */
export const DATABASE_NAME = 'uniover-offline';

/** Nome do banco da fila de uma conta: `uniover-offline-<id>`. */
export function offlineDbName(accountId: string): string {
  return accountDatabaseName(DATABASE_NAME, accountId);
}

/** Banco local da fila de escrita offline de UMA conta (IndexedDB, via Dexie). */
export class OfflineDb extends Dexie {
  declare outbox: EntityTable<OutboxItem, 'id'>;
  declare meta: EntityTable<MetaRow, 'key'>;

  constructor(name: string = DATABASE_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      // O índice composto devolve o mais antigo de cada status sem carregar a fila inteira.
      outbox: 'id, createdAt, [status+createdAt+id], status, nextAttemptAt',
      meta: 'key',
    });
  }
}

/**
 * O banco da fila da conta em uso. Sem fábrica padrão de propósito: quem o fornece é o escopo da conta
 * (`QueueScopes`), nunca um banco único do aparelho, que abriria o nome antigo e misturaria as contas.
 */
export const OFFLINE_DB = new InjectionToken<OfflineDb>('OFFLINE_DB');

/** Como criar o banco de uma conta a partir do nome dele (o teste troca por uma fábrica em memória). */
export const OFFLINE_DB_FACTORY = new InjectionToken<(name: string) => OfflineDb>(
  'OFFLINE_DB_FACTORY',
  { providedIn: 'root', factory: () => (name) => new OfflineDb(name) },
);
