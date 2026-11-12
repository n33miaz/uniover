import { signal } from '@angular/core';
import type { ShoppingDb, StoredEntity } from './shopping-db';
import {
  applyChanges,
  classifyResult,
  emptySnapshot,
  isEntityType,
  marketRows,
  openPurchase,
  project,
  withEntity,
  type Change,
  type OperationKind,
  type PendingOperation,
  type Snapshot,
} from './shopping-model';

/** Quantas operações vão num envio (o máximo que o servidor aceita). */
export const BATCH_SIZE = 50;

export interface OperationResult {
  readonly operationId: string;
  readonly status: number;
}

export interface ChangesPage {
  readonly groupId: string;
  readonly items: readonly Change[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** A conversa com o servidor. O teste troca por uma versão em memória. */
export interface ShoppingTransport {
  send(operations: readonly PendingOperation[]): Promise<readonly OperationResult[]>;
  changes(after: number): Promise<ChangesPage>;
  /** O preço pago da última vez por um produto, ou `null` se ele nunca foi comprado. */
  lastPrice(productId: string): Promise<number | null>;
}

export interface StorePorts {
  /** O aparelho tem rede? */
  online(): boolean;
  /** A sessão em mãos é da conta dona deste banco? Sem isso nada é enviado. */
  canSend(): boolean;
  now(): number;
  newId(): string;
}

/**
 * `synced`: nada a enviar. `pending`: enviando agora. `offline`: sem rede, a fila espera. `attention`: há rede, mas o
 * envio não foi (servidor acordando, sessão a confirmar); a próxima tentativa sai sozinha ou pelo toque da pessoa.
 */
export type SyncState = 'synced' | 'pending' | 'offline' | 'attention';

/**
 * Compras de uma conta neste aparelho. Toda escrita é gravada na fila (IndexedDB) ANTES de aparecer na tela e de
 * qualquer tentativa de envio: fechar o app no meio não perde nada. O envio sai em lotes, na ordem de gravação; cada
 * operação leva o próprio UUID, então reenviar depois de uma resposta perdida não a aplica de novo. Só sai da fila o
 * que o servidor aplicou ou recusou de vez; depois do envio o feed traz o que vale, e é ele que resolve um conflito.
 * Não há temporizador: as tentativas saem ao gravar, ao abrir a tela, quando a rede volta e quando a tela reaparece.
 */
export class ShoppingStore {
  /** O que a tela mostra: o retrato do servidor com as escritas pendentes por cima. */
  readonly snapshot = signal<Snapshot>(emptySnapshot());
  readonly pendingCount = signal(0);
  /**
   * A compra que o aparelho abriu e o servidor ainda não confirmou (ou `null`). As linhas de uma compra nascem no
   * servidor: até ele responder, a tela não deixa marcar nada nela, para um toque não virar uma linha repetida.
   */
  readonly unconfirmedPurchase = signal<string | null>(null);
  readonly state = signal<SyncState>('synced');
  /** O banco do aparelho já foi lido (a tela pode mostrar a lista, mesmo sem rede). */
  readonly ready = signal(false);
  /** O preço pago da última vez, por produto, para a compra aberta. */
  readonly lastPrices = signal<ReadonlyMap<string, number>>(new Map());

  private server = emptySnapshot();
  private pending: PendingOperation[] = [];
  private cursor = 0;
  private groupId: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private pricedPurchase: string | null = null;
  private readonly priced = new Set<string>();

  constructor(
    private readonly db: ShoppingDb,
    private readonly transport: ShoppingTransport,
    private readonly ports: StorePorts,
  ) {}

  /** Lê o que ficou no aparelho: o retrato, o cursor e a fila (inclusive o que não foi enviado antes de o app fechar). */
  async load(): Promise<void> {
    const [entities, operations, cursor, groupId] = await Promise.all([
      this.db.entities.toArray(),
      this.db.operations.orderBy('seq').toArray(),
      this.db.meta.get('cursor'),
      this.db.meta.get('groupId'),
    ]);
    let server = emptySnapshot();
    for (const row of entities) {
      if (isEntityType(row.type)) server = withEntity(server, row.type, row.payload);
    }
    this.server = server;
    this.pending = operations;
    this.cursor = typeof cursor?.value === 'number' ? cursor.value : 0;
    this.groupId = typeof groupId?.value === 'string' ? groupId.value : null;
    this.publish();
    if (this.pending.length > 0) this.state.set(this.ports.online() ? 'pending' : 'offline');
    this.ready.set(true);
  }

  /** Guarda uma escrita no aparelho e a mostra na tela; o envio é tentado em seguida, sem a tela esperar por ele. */
  async enqueue(
    kind: OperationKind,
    entityId: string,
    body: Readonly<Record<string, unknown>>,
    purchaseId?: string,
  ): Promise<void> {
    const operation: PendingOperation = {
      id: this.ports.newId(),
      kind,
      entityId,
      body,
      createdAt: this.ports.now(),
      ...(purchaseId ? { purchaseId } : {}),
    };
    const seq = await this.db.operations.add(operation);
    this.pending = [...this.pending, { ...operation, seq }];
    this.publish();
    void this.sync();
  }

  /** Envia a fila e traz o feed. Uma execução por vez; um pedido que chega durante outra roda logo depois dela. */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again && !this.closed) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  /** Espera a sincronização em curso terminar, inclusive a que ficou marcada para rodar logo depois dela. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Para de enviar e fecha o banco (troca de conta, saída da tela). A fila fica intacta no aparelho. */
  close(): void {
    this.closed = true;
    this.db.close();
  }

  private async run(): Promise<void> {
    if (!this.ports.online()) {
      this.state.set('offline');
      return;
    }
    if (!this.ports.canSend()) {
      this.state.set(this.pending.length > 0 ? 'attention' : 'synced');
      return;
    }
    if (this.pending.length > 0) this.state.set('pending');
    try {
      const sent = await this.flush();
      await this.pull();
      if (this.closed) return;
      this.state.set(sent && this.pending.length === 0 ? 'synced' : 'attention');
      void this.loadLastPrices();
    } catch {
      if (!this.closed) this.state.set(this.ports.online() ? 'attention' : 'offline');
    }
  }

  /** Esvazia a fila em lotes. Devolve falso se alguma operação ficou para depois (o envio para ali, para não martelar). */
  private async flush(): Promise<boolean> {
    for (;;) {
      const batch = await this.db.operations.orderBy('seq').limit(BATCH_SIZE).toArray();
      if (batch.length === 0) return true;

      const results = await this.transport.send(batch);
      const status = new Map(results.map((result) => [result.operationId, result.status]));
      // Sem desfecho na resposta, a operação fica: só sai da fila o que o servidor disse ter aplicado ou recusado.
      const settled = batch.filter(
        (operation) => classifyResult(status.get(operation.id) ?? 0) !== 'retry',
      );
      const done = new Set(settled.map((operation) => operation.id));
      await this.db.operations.bulkDelete(settled.map((operation) => operation.seq!));
      this.pending = this.pending.filter((operation) => !done.has(operation.id));
      this.publish();
      if (settled.length < batch.length) return false;
    }
  }

  /** Traz o feed depois do cursor. O retrato e o cursor são gravados juntos: ou os dois avançam, ou nenhum. */
  private async pull(): Promise<void> {
    for (;;) {
      const page = await this.transport.changes(this.cursor);
      if (this.groupId !== null && page.groupId !== this.groupId && this.cursor > 0) {
        // A pessoa trocou de grupo (entrou em outro, saiu, foi retirada): nada do grupo anterior continua na tela, e
        // o cursor dele não vale no novo. Recomeça do zero.
        await this.reset(page.groupId);
        continue;
      }

      const rows: StoredEntity[] = [];
      for (const change of page.items) {
        if (
          isEntityType(change.entityType) &&
          change.payload &&
          typeof change.payload === 'object'
        ) {
          rows.push({
            type: change.entityType,
            id: change.entityId,
            payload: { ...(change.payload as StoredEntity['payload']), id: change.entityId },
          });
        }
      }
      await this.db.transaction('rw', this.db.entities, this.db.meta, async () => {
        await this.db.entities.bulkPut(rows);
        await this.db.meta.bulkPut([
          { key: 'cursor', value: page.nextCursor },
          { key: 'groupId', value: page.groupId },
        ]);
      });
      this.server = applyChanges(this.server, page.items);
      this.cursor = page.nextCursor;
      this.groupId = page.groupId;
      this.publish();
      if (!page.hasMore) return;
    }
  }

  private async reset(groupId: string): Promise<void> {
    await this.db.transaction('rw', this.db.entities, this.db.meta, async () => {
      await this.db.entities.clear();
      await this.db.meta.bulkPut([
        { key: 'cursor', value: 0 },
        { key: 'groupId', value: groupId },
      ]);
    });
    this.server = emptySnapshot();
    this.cursor = 0;
    this.groupId = groupId;
    this.priced.clear();
    this.lastPrices.set(new Map());
    this.publish();
  }

  /** "Da última vez": uma consulta por produto da compra aberta, uma vez só por compra. Falhar aqui não atrapalha nada. */
  private async loadLastPrices(): Promise<void> {
    const snapshot = this.snapshot();
    const purchase = openPurchase(snapshot);
    if (!purchase) return;
    if (this.pricedPurchase !== purchase.id) {
      this.pricedPurchase = purchase.id;
      this.priced.clear();
      this.lastPrices.set(new Map());
    }
    const wanted = marketRows(snapshot, purchase)
      .map((row) => row.product.id)
      .filter((id) => !this.priced.has(id));
    for (const id of wanted) this.priced.add(id);
    await Promise.all(
      wanted.map(async (id) => {
        try {
          const price = await this.transport.lastPrice(id);
          if (price !== null && !this.closed) {
            this.lastPrices.update((prices) => new Map(prices).set(id, price));
          }
        } catch {
          this.priced.delete(id);
        }
      }),
    );
  }

  private publish(): void {
    this.snapshot.set(project(this.server, this.pending));
    this.pendingCount.set(this.pending.length);
    this.unconfirmedPurchase.set(
      this.pending.find((operation) => operation.kind === 'openPurchase')?.entityId ?? null,
    );
  }
}
