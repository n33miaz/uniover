import { signal } from '@angular/core';
import type { ShoppingDb, StoredEntity } from './shopping-db';
import {
  PURCHASE_ALREADY_OPEN,
  alignLines,
  applyChanges,
  applyOperation,
  classifyResult,
  emptySnapshot,
  isEntityType,
  marketRows,
  openPurchase,
  project,
  settleQueue,
  withEntity,
  withIds,
  type Change,
  type OperationKind,
  type PendingOperation,
  type Snapshot,
} from './shopping-model';

/** Uma pessoa do grupo, como vem no feed. */
interface MemberRow {
  readonly isOwner?: boolean;
  readonly deleted?: boolean;
}

function readIds(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  try {
    const ids: unknown = JSON.parse(value);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Quantas operações vão num envio (o máximo que o servidor aceita). */
export const BATCH_SIZE = 50;

export interface OperationResult {
  readonly operationId: string;
  readonly status: number;
  /** Na recusa, o tipo do problema (o mesmo que a rota daria). */
  readonly type?: string | null;
  /** Na recusa por já haver compra aberta no grupo, qual é ela. */
  readonly openPurchaseId?: string | null;
  /**
   * O registro em que a operação assentou. Difere do id enviado quando o grupo já tinha aquele registro (outro aparelho
   * criou o mesmo produto, item ou linha) e os dois foram juntados.
   */
  readonly entityId?: string | null;
}

/**
 * O que a tela precisa contar à pessoa sobre o último envio. `refused`: o servidor não aceitou uma mudança e ela foi
 * desfeita. `merged`: o grupo já tinha uma compra aberta, e o que foi marcado aqui passou para ela. `joined`: algo criado
 * aqui já existia no grupo e os dois viraram um só (nada se perdeu).
 */
export type SyncNotice = 'refused' | 'merged' | 'joined';

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
 * As tentativas saem ao gravar, ao abrir a tela, quando a rede volta e quando a tela reaparece; com outra pessoa no grupo
 * (`shared`) e a tela à vista, quem a hospeda (`ShoppingSession`) também consulta o feed a cada poucos segundos.
 */
export class ShoppingStore {
  /** O que a tela mostra: o retrato do servidor com as escritas pendentes por cima. */
  readonly snapshot = signal<Snapshot>(emptySnapshot());
  readonly pendingCount = signal(0);
  /**
   * A compra que o aparelho abriu e o servidor ainda não confirmou (ou `null`). Dá para marcar e pôr preço nela sem
   * sinal: quando o servidor responde, o que foi marcado vai para as linhas que ele criou (ver `alignLines`).
   */
  readonly unconfirmedPurchase = signal<string | null>(null);
  /** O recado do último envio, até a pessoa fazer outra mudança ou dispensá-lo. */
  readonly notice = signal<SyncNotice | null>(null);
  readonly state = signal<SyncState>('synced');
  /** O banco do aparelho já foi lido (a tela pode mostrar a lista, mesmo sem rede). */
  readonly ready = signal(false);
  /** O preço pago da última vez, por produto, para a compra aberta. */
  readonly lastPrices = signal<ReadonlyMap<string, number>>(new Map());
  /** Há outra pessoa neste grupo (alguém que pode estar mexendo na lista agora). */
  readonly shared = signal(false);
  /**
   * Conta cada mudança vista aqui: uma escrita da pessoa ou algo novo no feed. É o que diz a quem consulta o feed que a
   * lista está em uso (ver `LiveWatch`); a consulta que volta vazia não conta.
   */
  readonly activity = signal(0);

  private server = emptySnapshot();
  private pending: PendingOperation[] = [];
  private cursor = 0;
  private groupId: string | null = null;
  /** As pessoas do grupo que não o criaram (para quem o criou, as outras; para as outras, elas mesmas). */
  private others = new Set<string>();
  /** O aparelho já leu o feed numa versão que não guardava as pessoas: elas são relidas uma vez (ver `recallOthers`). */
  private othersUnknown = false;
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
    const [entities, operations, cursor, groupId, others] = await Promise.all([
      this.db.entities.toArray(),
      this.db.operations.orderBy('seq').toArray(),
      this.db.meta.get('cursor'),
      this.db.meta.get('groupId'),
      this.db.meta.get('others'),
    ]);
    let server = emptySnapshot();
    for (const row of entities) {
      if (isEntityType(row.type)) server = withEntity(server, row.type, row.payload);
    }
    this.server = server;
    this.pending = operations;
    this.cursor = typeof cursor?.value === 'number' ? cursor.value : 0;
    this.groupId = typeof groupId?.value === 'string' ? groupId.value : null;
    this.others = new Set(readIds(others?.value));
    this.othersUnknown = others === undefined && this.cursor > 0;
    this.shared.set(this.others.size > 0);
    this.publish();
    if (this.pending.length > 0) this.state.set(this.ports.online() ? 'pending' : 'offline');
    this.ready.set(true);
  }

  /**
   * Guarda uma escrita no aparelho e a mostra na tela; o envio é tentado em seguida, sem a tela esperar por ele. Apagar
   * algo que nasceu aqui e ainda não saiu do aparelho só tira da fila o que foi feito com ele (ver `dropUnsent`).
   */
  async enqueue(
    kind: OperationKind,
    entityId: string,
    body: Readonly<Record<string, unknown>>,
    purchaseId?: string,
  ): Promise<void> {
    this.activity.update((count) => count + 1);
    if (body['deleted'] === true && (await this.dropUnsent(kind, entityId))) {
      this.notice.set(null);
      this.publish();
      void this.sync();
      return;
    }
    const operation: PendingOperation = {
      id: this.ports.newId(),
      kind,
      entityId,
      body,
      createdAt: this.ports.now(),
      ...(purchaseId ? { purchaseId } : {}),
    };
    // Entra na memória já, e na tela só depois de gravada: um envio em curso que acerte as linhas da fila neste meio
    // tempo (ver `align`) acerta esta também, em vez de ela reaparecer com o id antigo.
    this.pending = [...this.pending, operation];
    let seq: number;
    try {
      seq = await this.db.operations.add(operation);
    } catch (error) {
      this.pending = this.pending.filter((candidate) => candidate.id !== operation.id);
      throw error;
    }
    this.pending = this.pending.map((candidate) =>
      candidate.id === operation.id ? { ...candidate, seq } : candidate,
    );
    this.notice.set(null);
    this.publish();
    void this.sync();
  }

  /**
   * Apagar o que foi criado aqui e o servidor nunca recebeu: a criação e o que veio depois dela saem da fila, e o
   * "apagar" nem entra. Enviados, o servidor podia juntar a criação a um registro igual do grupo e o "apagar" chegaria
   * por um id que não é mais de ninguém daqui. Só vale se nada da fila já saiu do aparelho (sem resposta não se sabe
   * se o servidor aplicou) e se nenhuma outra escrita depende do registro (o item de um produto, por exemplo). O resto
   * da fila fica na mesma ordem: só há remoção.
   */
  private async dropUnsent(kind: OperationKind, entityId: string): Promise<boolean> {
    if (!this.unknownToServer(kind, entityId)) return false;
    const dropped = await this.db.transaction('rw', this.db.operations, async () => {
      const stored = await this.db.operations.orderBy('seq').toArray();
      const mine = stored.filter(
        (operation) => operation.kind === kind && operation.entityId === entityId,
      );
      const ids = new Set(mine.map((operation) => operation.id));
      // Uma escrita deste registro que ainda está sendo gravada existe só na memória: na dúvida, nada é descartado.
      const unsaved = this.pending.some(
        (operation) =>
          operation.kind === kind && operation.entityId === entityId && !ids.has(operation.id),
      );
      const needed = stored.some(
        (operation) => !ids.has(operation.id) && operation.body['productId'] === entityId,
      );
      if (mine.length === 0 || unsaved || needed || mine.some((operation) => operation.sent)) {
        return null;
      }
      await this.db.operations.bulkDelete(mine.map((operation) => operation.seq!));
      return ids;
    });
    if (!dropped) return false;
    this.pending = this.pending.filter((operation) => !dropped.has(operation.id));
    return true;
  }

  private unknownToServer(kind: OperationKind, entityId: string): boolean {
    switch (kind) {
      case 'product':
        return !this.server.products.has(entityId);
      case 'listItem':
        return !this.server.listItems.has(entityId);
      case 'purchaseItem':
        return !this.server.purchaseItems.has(entityId);
      default:
        return false;
    }
  }

  /**
   * Marca o lote como enviado antes de enviá-lo, numa transação: o que `dropUnsent` descartou antes dela não sai, e o
   * que sai já não pode ser descartado. Devolve o lote como está gravado agora.
   */
  private async markSent(batch: readonly PendingOperation[]): Promise<PendingOperation[]> {
    return this.db.transaction('rw', this.db.operations, async () => {
      const current = (
        await this.db.operations.bulkGet(batch.map((operation) => operation.seq!))
      ).filter((operation): operation is PendingOperation => operation !== undefined);
      const marked = current.map((operation) =>
        operation.sent ? operation : { ...operation, sent: true as const },
      );
      await this.db.operations.bulkPut(marked);
      return marked;
    });
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
    let aligned = false;
    for (;;) {
      const queue = await this.db.operations.orderBy('seq').limit(BATCH_SIZE).toArray();
      if (queue.length === 0) return true;
      // A abertura de uma compra fecha o lote: o que vem depois dela depende da resposta (a compra pode ser outra, e
      // as linhas nascem no servidor), então só é enviado depois de acertado com o que o servidor disser.
      const opening = queue.findIndex((operation) => operation.kind === 'openPurchase');
      const batch = opening < 0 ? queue : queue.slice(0, opening + 1);

      // Uma linha de compra criada aqui só é enviada depois de o aparelho ver as linhas que o servidor tem: é o que
      // impede duas linhas do mesmo produto (a segunda seria recusada e o toque, perdido). A conferência é sobre o
      // lote lido do banco, e o lote é lido de novo depois de acertado.
      if (!aligned && this.hasNewLines(batch)) {
        await this.pull();
        aligned = true;
        continue;
      }
      aligned = false;

      const sending = await this.markSent(batch);
      if (sending.length === 0) continue;
      const results = await this.transport.send(sending);
      const byId = new Map(results.map((result) => [result.operationId, result]));
      // Sem desfecho na resposta, a operação fica: só sai da fila o que o servidor disse ter aplicado ou recusado.
      const settled = sending.filter(
        (operation) => classifyResult(byId.get(operation.id)?.status ?? 0) !== 'retry',
      );
      let adopt: { readonly from: string; readonly to: string } | null = null;
      let notice: SyncNotice | null = null;
      // O que foi criado aqui e o grupo já tinha: o servidor juntou os dois e disse qual registro vale.
      const ids = new Map<string, string>();
      for (const operation of settled) {
        const result = byId.get(operation.id)!;
        if (classifyResult(result.status) !== 'refused') {
          if (result.entityId && result.entityId !== operation.entityId) {
            ids.set(operation.entityId, result.entityId);
          }
          // Aplicada: o retrato já a mostra, sem esperar o feed. Senão, entre sair da fila e o feed chegar, o que a
          // pessoa acabou de fazer sumiria da tela por um instante (e um campo em uso seria refeito, vazio). Ela entra
          // com os ids que valem: com o id daqui, o registro juntado apareceria duas vezes.
          this.server = applyOperation(this.server, withIds(operation, ids));
          continue;
        }
        const open = result.openPurchaseId;
        if (
          operation.kind === 'openPurchase' &&
          open &&
          result.type?.endsWith(PURCHASE_ALREADY_OPEN)
        ) {
          // O grupo já tinha uma compra aberta: vale a do servidor, e o que foi marcado aqui passa para ela.
          adopt = { from: operation.entityId, to: open };
        } else {
          notice = 'refused';
        }
      }

      // A fila gravada e a da memória são acertadas cada uma pelo que tem: uma escrita que ainda está sendo gravada
      // existe só na memória, e não pode voltar ao banco por aqui.
      const gone = new Set(settled.map((operation) => operation.id));
      const purchase = adopt;
      await this.db.transaction('rw', this.db.operations, async () => {
        await this.db.operations.bulkDelete(settled.map((operation) => operation.seq!));
        if (!purchase && ids.size === 0) return;
        const stored = await this.db.operations.orderBy('seq').toArray();
        const saved = settleQueue(stored, ids, purchase);
        await this.db.operations.bulkDelete(saved.dropped.map((operation) => operation.seq!));
        await this.db.operations.bulkPut([...saved.changed]);
      });
      const waiting = settleQueue(
        this.pending.filter((operation) => !gone.has(operation.id)),
        ids,
        purchase,
      );
      for (const operation of waiting.dropped) gone.add(operation.id);
      const moved = new Map(waiting.changed.map((operation) => [operation.id, operation]));
      // Só há o que contar se algo mudou de compra: a abertura repetida da própria compra não é notícia.
      if (purchase && (moved.size > 0 || waiting.dropped.length > 0)) notice ??= 'merged';
      if (ids.size > 0) notice ??= 'joined';
      this.pending = this.pending
        .filter((operation) => !gone.has(operation.id))
        .map((operation) => moved.get(operation.id) ?? operation);
      if (notice) this.notice.set(notice);
      this.publish();
      if (settled.length < sending.length) return false;
    }
  }

  /** O lote leva uma linha de compra que o servidor ainda não conhece? (A abertura, se houver, é a última do lote.) */
  private hasNewLines(batch: readonly PendingOperation[]): boolean {
    return batch.some(
      (operation) =>
        operation.kind === 'purchaseItem' && !this.server.purchaseItems.has(operation.entityId),
    );
  }

  /**
   * Põe as linhas criadas aqui sobre as que o servidor tem (ver `alignLines`). Vale o que está gravado no banco; a
   * memória acompanha pelo id da operação, inclusive a escrita que ainda está sendo gravada.
   */
  private async align(): Promise<void> {
    const stored = await this.db.operations.orderBy('seq').toArray();
    const changed = alignLines(this.server, stored);
    if (changed.length > 0) await this.db.operations.bulkPut([...changed]);
    const line = new Map(
      alignLines(this.server, this.pending).map((operation) => [operation.id, operation.entityId]),
    );
    for (const operation of changed) line.set(operation.id, operation.entityId);
    if (line.size === 0) return;
    this.pending = this.pending.map((operation) => {
      const entityId = line.get(operation.id);
      return entityId ? { ...operation, entityId } : operation;
    });
  }

  /** Traz o feed depois do cursor. O retrato e o cursor são gravados juntos: ou os dois avançam, ou nenhum. */
  private async pull(): Promise<void> {
    if (this.othersUnknown) await this.recallOthers();
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
      if (page.items.length > 0) this.activity.update((count) => count + 1);
      const others = new Set(this.others);
      for (const change of page.items) {
        const member = change.entityType === 'member' ? (change.payload as MemberRow | null) : null;
        if (!member || member.isOwner) continue;
        if (member.deleted) others.delete(change.entityId);
        else others.add(change.entityId);
      }
      await this.db.transaction('rw', this.db.entities, this.db.meta, async () => {
        await this.db.entities.bulkPut(rows);
        await this.db.meta.bulkPut([
          { key: 'cursor', value: page.nextCursor },
          { key: 'groupId', value: page.groupId },
          { key: 'others', value: JSON.stringify([...others]) },
        ]);
      });
      this.others = others;
      this.shared.set(others.size > 0);
      this.server = applyChanges(this.server, page.items);
      this.cursor = page.nextCursor;
      this.groupId = page.groupId;
      // Antes de a tela ver o retrato novo: senão o mesmo produto apareceria em duas linhas por um instante.
      if (!page.hasMore) await this.align();
      this.publish();
      if (!page.hasMore) return;
    }
  }

  /**
   * As pessoas do grupo, relidas do começo do feed: só acontece uma vez, no aparelho que já tinha passado por elas
   * antes de o app guardá-las. Nada do retrato muda; reler é só olhar de novo o que o servidor já contou.
   */
  private async recallOthers(): Promise<void> {
    const others = new Set<string>();
    let after = 0;
    for (;;) {
      const page = await this.transport.changes(after);
      for (const change of page.items) {
        const member = change.entityType === 'member' ? (change.payload as MemberRow | null) : null;
        if (!member || member.isOwner) continue;
        if (member.deleted) others.delete(change.entityId);
        else others.add(change.entityId);
      }
      after = page.nextCursor;
      if (!page.hasMore) break;
    }
    await this.db.meta.put({ key: 'others', value: JSON.stringify([...others]) });
    this.others = others;
    this.othersUnknown = false;
    this.shared.set(others.size > 0);
  }

  private async reset(groupId: string): Promise<void> {
    await this.db.transaction('rw', this.db.entities, this.db.meta, async () => {
      await this.db.entities.clear();
      await this.db.meta.bulkPut([
        { key: 'cursor', value: 0 },
        { key: 'groupId', value: groupId },
        { key: 'others', value: '[]' },
      ]);
    });
    this.others = new Set();
    this.shared.set(false);
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
