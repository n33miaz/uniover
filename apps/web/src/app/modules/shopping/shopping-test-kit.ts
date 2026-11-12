import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { ShoppingDb } from './shopping-db';
import type { Change, PendingOperation } from './shopping-model';
import {
  ShoppingStore,
  type ChangesPage,
  type OperationResult,
  type ShoppingTransport,
} from './shopping-store';

const ALREADY_OPEN = 'https://uniover.test/problems/shopping-purchase-already-open';
const DUPLICATE = 'https://uniover.test/problems/shopping-duplicate';

interface Row {
  readonly type: string;
  readonly id: string;
  payload: Record<string, unknown>;
}

/**
 * Um servidor de Compras de mentira, com as regras do de verdade que importam para a fila do aparelho: cada operação é
 * aplicada uma vez só; um grupo tem uma compra aberta por vez (a segunda abertura é recusada e diz qual é a aberta);
 * as linhas da compra nascem aqui, uma por item que "precisa"; e uma compra tem uma linha por produto.
 */
export class MarketServer implements ShoppingTransport {
  groupId = 'group-1';
  readonly feed: Change[] = [];
  readonly batches: string[][] = [];
  /** O envio cai como a rede cairia. */
  fail = false;
  private readonly rows = new Map<string, Row>();
  private readonly applied = new Map<string, OperationResult>();
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

  private apply(operation: PendingOperation): Omit<OperationResult, 'operationId'> {
    const id = operation.entityId;
    const body = operation.body;
    switch (operation.kind) {
      case 'product':
        this.put('product', id, { name: body['name'], section: '', deleted: false });
        return { status: 200 };
      case 'listItem':
        this.put('listItem', id, { ...body, deleted: false });
        return { status: 200 };
      case 'openPurchase': {
        if (this.rows.has(id)) return { status: 200 };
        const open = this.rowsOf('purchase').find((row) => row.payload['status'] === 'open');
        if (open) return { status: 409, type: ALREADY_OPEN, openPurchaseId: open.id };
        this.put('purchase', id, { status: 'open', deleted: false });
        for (const item of this.rowsOf('listItem')) {
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
        const twin = this.rowsOf('purchaseItem').find(
          (row) =>
            row.id !== id &&
            row.payload['purchaseId'] === purchase.id &&
            row.payload['productId'] === body['productId'],
        );
        if (twin) return { status: 409, type: DUPLICATE };
        this.put('purchaseItem', id, { ...body, purchaseId: purchase.id, deleted: false });
        return { status: 200 };
      }
    }
  }
}

export interface StoreBench {
  readonly server: MarketServer;
  online: boolean;
  /** Abre o app: um banco novo sobre o mesmo IndexedDB, como depois de fechar e abrir de novo. */
  open(): Promise<ShoppingStore>;
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
    async open() {
      const db = new ShoppingDb('uniover-shopping-test', {
        indexedDB,
        IDBKeyRange: FakeIDBKeyRange,
      });
      const store = new ShoppingStore(db, bench.server, {
        online: () => bench.online,
        canSend: () => true,
        now: () => 1_700_000_000_000,
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
