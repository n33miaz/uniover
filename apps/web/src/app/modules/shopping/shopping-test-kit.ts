import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { ShoppingDb } from './shopping-db';
import { normalizeName, type Change, type PendingOperation } from './shopping-model';
import {
  ShoppingStore,
  type ChangesPage,
  type OperationResult,
  type ShoppingTransport,
} from './shopping-store';

const ALREADY_OPEN = 'https://uniover.test/problems/shopping-purchase-already-open';

interface Row {
  readonly type: string;
  readonly id: string;
  payload: Record<string, unknown>;
}

/**
 * Um servidor de Compras de mentira, com as regras do de verdade que importam para a fila do aparelho: cada operação é
 * aplicada uma vez só; um grupo tem uma compra aberta por vez (a segunda abertura é recusada e diz qual é a aberta);
 * as linhas da compra nascem aqui, uma por item que "precisa"; e um produto, um item da lista ou uma linha de compra
 * criado por dois aparelhos vira um registro só (o segundo é juntado ao primeiro, e a resposta diz qual vale).
 */
export class MarketServer implements ShoppingTransport {
  groupId = 'group-1';
  readonly feed: Change[] = [];
  readonly batches: string[][] = [];
  /** O envio cai como a rede cairia. */
  fail = false;
  private readonly rows = new Map<string, Row>();
  private readonly applied = new Map<string, OperationResult>();
  /** O id criado num aparelho para algo que já existia aqui, e o registro que vale. */
  private readonly merged = new Map<string, string>();
  private readonly pricedAt = new Map<string, number>();
  private lines = 0;

  /** Outra pessoa do grupo fez isto direto no servidor. */
  put(type: string, id: string, payload: Record<string, unknown>): void {
    this.rows.set(id, { type, id, payload });
    this.feed.push({ sequence: this.feed.length + 1, entityType: type, entityId: id, payload });
  }

  rowsOf(type: string): readonly Row[] {
    return [...this.rows.values()].filter((row) => row.type === type);
  }

  async send(operations: readonly PendingOperation[]): Promise<readonly OperationResult[]> {
    if (this.fail) throw new Error('sem rede');
    this.batches.push(operations.map((operation) => `${operation.kind}:${operation.entityId}`));
    return operations.map((operation) => {
      const known = this.applied.get(operation.id);
      if (known) return known;
      const result = { operationId: operation.id, ...this.apply(operation) };
      if (result.status === 200) this.applied.set(operation.id, result);
      return result;
    });
  }

  async changes(after: number): Promise<ChangesPage> {
    if (this.fail) throw new Error('sem rede');
    const items = this.feed.filter((change) => change.sequence > after);
    return {
      groupId: this.groupId,
      items,
      nextCursor: items.length > 0 ? items[items.length - 1].sequence : after,
      hasMore: false,
    };
  }

  async lastPrice(): Promise<number | null> {
    return null;
  }

  private alive(type: string, id: string, same: (row: Row) => boolean): Row | undefined {
    return this.rowsOf(type).find(
      (row) => row.id !== id && row.payload['deleted'] !== true && same(row),
    );
  }

  private apply(operation: PendingOperation): Omit<OperationResult, 'operationId'> {
    const id = this.merged.get(operation.entityId) ?? operation.entityId;
    const { only, ...sent } = operation.body;
    const productId = String(sent['productId'] ?? '');
    const body: Record<string, unknown> = {
      ...sent,
      productId: this.merged.get(productId) ?? sent['productId'],
    };
    const known = this.rows.get(id);
    if (body['deleted'] === true && operation.kind !== 'openPurchase') {
      // Apagar pelo id de uma cópia juntada não apaga o registro que ficou: responde 204 e nada muda.
      if (this.merged.has(operation.entityId)) return { status: 204 };
      if (!known) return { status: 404 };
      this.put(known.type, id, { ...known.payload, deleted: true });
      return { status: 200, entityId: id };
    }
    switch (operation.kind) {
      case 'product': {
        const name = normalizeName(String(body['name'] ?? ''));
        const twin = this.alive(
          'product',
          id,
          (row) => normalizeName(String(row.payload['name'])) === name,
        );
        if (twin && !known) {
          this.merged.set(id, twin.id);
          this.put('product', twin.id, twin.payload);
          return { status: 200, entityId: twin.id };
        }
        this.put('product', id, {
          name: body['name'],
          section: body['section'] ?? '',
          unit: body['unit'] ?? null,
          deleted: false,
        });
        return { status: 200, entityId: id };
      }
      case 'listItem': {
        const twin = this.alive(
          'listItem',
          id,
          (row) => row.payload['productId'] === body['productId'],
        );
        if (twin && !known) {
          this.merged.set(id, twin.id);
          this.put('listItem', twin.id, {
            ...twin.payload,
            needed: twin.payload['needed'] === true || body['needed'] === true,
            quantity: Math.max(Number(twin.payload['quantity']), Number(body['quantity'])),
          });
          return { status: 200, entityId: twin.id };
        }
        this.put(
          'listItem',
          id,
          known && only === 'needed'
            ? { ...known.payload, needed: body['needed'] }
            : { ...body, deleted: false },
        );
        return { status: 200, entityId: id };
      }
      case 'openPurchase': {
        if (this.rows.has(id)) return { status: 200 };
        const open = this.rowsOf('purchase').find((row) => row.payload['status'] === 'open');
        if (open) return { status: 409, type: ALREADY_OPEN, openPurchaseId: open.id };
        const fromList = body['fromList'] !== false;
        this.put('purchase', id, { status: 'open', fromList, deleted: false });
        for (const item of fromList ? this.rowsOf('listItem') : []) {
          if (item.payload['needed'] !== true) continue;
          this.put('purchaseItem', `server-line-${++this.lines}`, {
            purchaseId: id,
            productId: item.payload['productId'],
            quantity: item.payload['quantity'],
            unitPrice: null,
            picked: false,
            deleted: false,
          });
        }
        return { status: 200 };
      }
      case 'budget': {
        const purchase = this.rows.get(id);
        if (!purchase) return { status: 404 };
        this.put('purchase', id, { ...purchase.payload, budget: body['budget'] });
        return { status: 200 };
      }
      case 'closePurchase': {
        const purchase = this.rows.get(id);
        if (!purchase) return { status: 404 };
        this.put('purchase', id, { ...purchase.payload, status: 'closed', ...body });
        return { status: 200 };
      }
      case 'purchaseItem': {
        const purchase = this.rows.get(operation.purchaseId ?? '');
        if (!purchase) return { status: 404 };
        const twin = this.alive(
          'purchaseItem',
          id,
          (row) =>
            row.payload['purchaseId'] === purchase.id &&
            row.payload['productId'] === body['productId'],
        );
        const line = twin && !known ? twin : known;
        // Na linha que nasce aqui, o campo que a pessoa não mexeu entra neutro, como a junção o trataria.
        const next: Record<string, unknown> = line
          ? { ...line.payload }
          : { ...body, unitPrice: null, picked: false, purchaseId: purchase.id, deleted: false };
        if (twin && !known) {
          this.merged.set(id, twin.id);
          next['picked'] =
            twin.payload['picked'] === true || (only !== 'price' && body['picked'] === true);
          next['quantity'] = Math.max(Number(twin.payload['quantity']), Number(body['quantity']));
        } else {
          if (!line || !only) next['quantity'] = body['quantity'];
          if (only !== 'price') next['picked'] = body['picked'] === true;
        }
        // O preço informado por último vale; num registro juntado, "sem preço" não informa nada.
        const price = (body['unitPrice'] as number | null | undefined) ?? null;
        const target = line?.id ?? id;
        const informed =
          only !== 'picked' &&
          !(price === null && (next['unitPrice'] ?? null) === null) &&
          !(twin && !known && price === null);
        if (informed && operation.createdAt >= (this.pricedAt.get(target) ?? -Infinity)) {
          next['unitPrice'] = price;
          // A promoção anda com o preço (some quando ele some), como no servidor.
          next['regularPrice'] = price === null ? null : (body['regularPrice'] ?? null);
          next['promoNote'] =
            price === null ? null : String(body['promoNote'] ?? '').trim() || null;
          this.pricedAt.set(target, operation.createdAt);
        }
        this.put('purchaseItem', target, next);
        return { status: 200, entityId: target };
      }
    }
  }
}

export interface StoreBench {
  readonly server: MarketServer;
  online: boolean;
  /** O relógio dos aparelhos (a hora em que a pessoa faz cada mudança). */
  clock: number;
  /** O IndexedDB em memória dos aparelhos, para o teste abrir um banco por fora. */
  readonly idb: { readonly indexedDB: IDBFactory; readonly IDBKeyRange: typeof IDBKeyRange };
  /**
   * Abre o app: um banco novo sobre o mesmo IndexedDB, como depois de fechar e abrir de novo. Outro `device` é outro
   * aparelho, com o banco dele.
   */
  open(device?: string): Promise<ShoppingStore>;
  close(): void;
}

/** Uma bancada para a fila de Compras: IndexedDB em memória, o servidor de mentira e o interruptor do sinal. */
export function storeBench(): StoreBench {
  const indexedDB = new FakeIDBFactory();
  const stores: ShoppingStore[] = [];
  let ids = 0;
  const bench: StoreBench = {
    server: new MarketServer(),
    online: true,
    clock: 1_700_000_000_000,
    idb: { indexedDB, IDBKeyRange: FakeIDBKeyRange },
    async open(device = 'test') {
      const db = new ShoppingDb(`uniover-shopping-${device}`, {
        indexedDB,
        IDBKeyRange: FakeIDBKeyRange,
      });
      const store = new ShoppingStore(db, bench.server, {
        online: () => bench.online,
        canSend: () => true,
        now: () => bench.clock,
        newId: () => `op-${++ids}`,
      });
      stores.push(store);
      await store.load();
      return store;
    },
    close() {
      for (const store of stores.splice(0)) store.close();
    },
  };
  return bench;
}
