import { Injectable, inject, signal } from '@angular/core';
import Dexie from 'dexie';
import { OFFLINE_DB, OutboxItem, OutboxMethod, OutboxStatus } from './offline-db';
import { QUEUE_RUNTIME } from './queue-ports';
import { uuidV7 } from './uuid-v7';

export interface NewOutboxItem {
  readonly method: OutboxMethod;
  readonly url: string;
  readonly body?: unknown;
  readonly module: string;
}

/** O armazenamento do aparelho está cheio: o item NÃO foi guardado. */
export class QueueStorageFullError extends Error {
  constructor(options?: ErrorOptions) {
    super('Sem espaço no aparelho para guardar o item.', options);
    this.name = 'QueueStorageFullError';
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'QuotaExceededError'
  );
}

const LAST_SYNC_KEY = 'lastSyncAt';
const PERSIST_KEY = 'persistRequested';

/**
 * Tudo o que toca o IndexedDB da fila. As mudanças que dependem do estado anterior (marcar em envio, dar por
 * enviado, reagendar) acontecem dentro de uma transação de leitura e escrita, para a decisão e a gravação
 * verem a mesma linha.
 */
@Injectable({ providedIn: 'root' })
export class OutboxStore {
  private readonly db = inject(OFFLINE_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);

  private readonly _pendingCount = signal(0);
  private readonly _failedCount = signal(0);
  private readonly _lastSyncAt = signal<number | null>(null);

  /** Itens a enviar (esperando ou em voo). */
  readonly pendingCount = this._pendingCount.asReadonly();
  /** Itens recusados de vez, à espera de o usuário descartar ou reenviar. */
  readonly failedCount = this._failedCount.asReadonly();
  /** Instante (ms) do último envio aceito pelo servidor. */
  readonly lastSyncAt = this._lastSyncAt.asReadonly();

  /** Grava o item e só então resolve: a promessa significa "guardado", não "enviado". */
  async add(input: NewOutboxItem): Promise<OutboxItem> {
    try {
      const item = await this.db.transaction('rw', this.db.outbox, async () => {
        // `createdAt` só cresce: dois itens no mesmo milissegundo, ou um relógio que recuou, não embaralham a fila.
        const last = await this.db.outbox.orderBy('createdAt').last();
        const created: OutboxItem = {
          id: uuidV7(),
          method: input.method,
          url: input.url,
          body: input.body,
          module: input.module,
          createdAt: Math.max(this.runtime.now(), (last?.createdAt ?? 0) + 1),
          attempts: 0,
          nextAttemptAt: 0,
          status: 'pending',
          lastError: null,
          revision: 0,
        };
        await this.db.outbox.add(created);
        return created;
      });
      await this.refresh();
      return item;
    } catch (error) {
      if (isQuotaError(error)) throw new QueueStorageFullError({ cause: error });
      throw error;
    }
  }

  /**
   * Na partida: o que ficou `sending` é de uma aba que fechou no meio do envio (ninguém mais vai terminá-lo).
   * Volta a `pending`; a mesma `Idempotency-Key` garante que o servidor não duplique.
   */
  async resetSending(): Promise<void> {
    await this.db.outbox.where('status').equals('sending').modify({ status: 'pending' });
    await this.refresh();
  }

  /** O mais antigo dos que esperam envio (FIFO por `createdAt`; o id desempata). */
  oldestPending(): Promise<OutboxItem | undefined> {
    return this.db.outbox
      .where('[status+createdAt+id]')
      .between(['pending', Dexie.minKey, Dexie.minKey], ['pending', Dexie.maxKey, Dexie.maxKey])
      .first();
  }

  /** Marca em voo e conta a tentativa. Devolve `undefined` se o item mudou ou sumiu desde que foi lido. */
  markSending(id: string, revision: number): Promise<OutboxItem | undefined> {
    return this.db.transaction('rw', this.db.outbox, async () => {
      const row = await this.db.outbox.get(id);
      if (!row || row.status !== 'pending' || row.revision !== revision) return undefined;
      const next: OutboxItem = { ...row, status: 'sending', attempts: row.attempts + 1 };
      await this.db.outbox.put(next);
      return next;
    });
  }

  /**
   * Remove o item **só se nada mudou durante o voo** (mesma revisão). Registra o instante do último envio aceito
   * de qualquer jeito: o servidor aceitou. Devolve se removeu.
   */
  async complete(id: string, revision: number): Promise<boolean> {
    const removed = await this.db.transaction('rw', this.db.outbox, this.db.meta, async () => {
      const row = await this.db.outbox.get(id);
      await this.db.meta.put({ key: LAST_SYNC_KEY, value: this.runtime.now() });
      if (!row || row.revision !== revision) return false;
      await this.db.outbox.delete(id);
      return true;
    });
    await this.refresh();
    return removed;
  }

  /** Volta o item para `pending` com a próxima tentativa agendada. Não mexe se ele mudou durante o voo. */
  async scheduleRetry(
    id: string,
    revision: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    await this.settle(id, revision, { status: 'pending', nextAttemptAt, lastError: error });
  }

  /** Recusa definitiva: o item fica visível como `failed` e deixa de ser tentado. */
  async markFailed(id: string, revision: number, error: string): Promise<void> {
    await this.settle(id, revision, { status: 'failed', lastError: error });
  }

  /**
   * Edita o corpo de um item. Se ele ainda não foi enviado, mantém o id; se já foi tentado, ganha um id novo
   * (a mesma chave com outro corpo seria recusada pelo servidor como reuso) e mantém o lugar na fila. Quem
   * estava em voo com o id antigo não consegue dar o item por enviado.
   */
  update(id: string, patch: { readonly body: unknown }): Promise<OutboxItem | undefined> {
    return this.mutate(id, async (row) => {
      const next: OutboxItem = {
        ...row,
        id: row.attempts > 0 ? uuidV7() : row.id,
        body: patch.body,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        revision: row.revision + 1,
      };
      if (next.id !== row.id) await this.db.outbox.delete(row.id);
      await this.db.outbox.put(next);
      return next;
    });
  }

  /** Reenvio manual de um item `failed`: volta a `pending`, com a mesma chave, sem contagem de tentativas. */
  retry(id: string): Promise<OutboxItem | undefined> {
    return this.mutate(id, async (row) => {
      if (row.status !== 'failed') return undefined;
      const next: OutboxItem = {
        ...row,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        revision: row.revision + 1,
      };
      await this.db.outbox.put(next);
      return next;
    });
  }

  /** Descarta um item (só por decisão do usuário; nenhum caminho automático chama isto). */
  async discard(id: string): Promise<boolean> {
    const existed = await this.db.transaction('rw', this.db.outbox, async () => {
      const row = await this.db.outbox.get(id);
      if (!row) return false;
      await this.db.outbox.delete(id);
      return true;
    });
    await this.refresh();
    return existed;
  }

  async get(id: string): Promise<OutboxItem | undefined> {
    return this.db.outbox.get(id);
  }

  /** Todos os itens, do mais antigo ao mais novo. */
  list(): Promise<OutboxItem[]> {
    return this.db.outbox.orderBy('createdAt').toArray();
  }

  /** Relê contadores e último envio do IndexedDB (também chamado ao voltar à aba: outra aba pode ter mexido). */
  async refresh(): Promise<void> {
    const [pending, sending, failed, lastSync] = await Promise.all([
      this.countStatus('pending'),
      this.countStatus('sending'),
      this.countStatus('failed'),
      this.db.meta.get(LAST_SYNC_KEY),
    ]);
    this._pendingCount.set(pending + sending);
    this._failedCount.set(failed);
    this._lastSyncAt.set(typeof lastSync?.value === 'number' ? lastSync.value : null);
  }

  /** Marca, no banco, que o pedido de armazenamento persistente já foi feito. `true` se era a primeira vez. */
  claimPersistRequest(): Promise<boolean> {
    return this.db.transaction('rw', this.db.meta, async () => {
      if (await this.db.meta.get(PERSIST_KEY)) return false;
      await this.db.meta.put({ key: PERSIST_KEY, value: true });
      return true;
    });
  }

  private countStatus(status: OutboxStatus): Promise<number> {
    return this.db.outbox.where('status').equals(status).count();
  }

  private async settle(
    id: string,
    revision: number,
    changes: Partial<Pick<OutboxItem, 'status' | 'nextAttemptAt' | 'lastError'>>,
  ): Promise<void> {
    await this.db.transaction('rw', this.db.outbox, async () => {
      const row = await this.db.outbox.get(id);
      if (!row || row.revision !== revision) return;
      await this.db.outbox.put({ ...row, ...changes });
    });
    await this.refresh();
  }

  private async mutate(
    id: string,
    change: (row: OutboxItem) => Promise<OutboxItem | undefined>,
  ): Promise<OutboxItem | undefined> {
    const result = await this.db.transaction('rw', this.db.outbox, async () => {
      const row = await this.db.outbox.get(id);
      return row ? change(row) : undefined;
    });
    await this.refresh();
    return result;
  }
}
