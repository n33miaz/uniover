import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { ShoppingDb } from './shopping-db';
import { listSections, type Change, type PendingOperation } from './shopping-model';
import {
  BATCH_SIZE,
  ShoppingStore,
  type ChangesPage,
  type OperationResult,
  type ShoppingTransport,
} from './shopping-store';

/**
 * Um servidor de mentira com as três regras que importam aqui: aplica cada operação uma vez só (pelo UUID dela), numera
 * o feed na ordem em que aplicou e responde por operação. `fail` derruba o envio como a rede faria; `refuse` e `later`
 * decidem o desfecho de uma operação.
 */
class FakeServer implements ShoppingTransport {
  groupId = 'group-1';
  feed: Change[] = [];
  readonly applied: string[] = [];
  readonly batches: string[][] = [];
  fail = false;
  /** A resposta se perde depois de o servidor aplicar o lote. */
  loseResponse = false;
  refuse = new Set<string>();
  later = new Set<string>();
  changesCalls: number[] = [];

  async send(operations: readonly PendingOperation[]): Promise<readonly OperationResult[]> {
    if (this.fail) throw new Error('sem rede');
    this.batches.push(operations.map((operation) => operation.entityId));
    const results = operations.map((operation) => {
      if (this.later.has(operation.entityId)) return { operationId: operation.id, status: 503 };
      if (this.refuse.has(operation.entityId)) return { operationId: operation.id, status: 409 };
      if (!this.applied.includes(operation.id)) {
        this.applied.push(operation.id);
        this.feed.push({
          sequence: this.feed.length + 1,
          entityType: operation.kind === 'product' ? 'product' : 'listItem',
          entityId: operation.entityId,
          payload: { ...operation.body, deleted: false },
        });
      }
      return { operationId: operation.id, status: 200 };
    });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new Error('resposta perdida');
    }
    return results;
  }

  async changes(after: number): Promise<ChangesPage> {
    if (this.fail) throw new Error('sem rede');
    this.changesCalls.push(after);
    const items = this.feed.filter((change) => change.sequence > after).slice(0, 2);
    const nextCursor = items.length > 0 ? items[items.length - 1].sequence : after;
    return {
      groupId: this.groupId,
      items,
      nextCursor,
      hasMore: this.feed.some((change) => change.sequence > nextCursor),
    };
  }

  async lastPrice(): Promise<number | null> {
    return null;
  }
}

describe('ShoppingStore', () => {
  let indexedDB: InstanceType<typeof FakeIDBFactory>;
  let server: FakeServer;
  let online: boolean;
  let canSend: boolean;
  let ids: number;
  const stores: ShoppingStore[] = [];

  /** Abre o app: um banco novo sobre o mesmo IndexedDB, como depois de fechar e abrir de novo. */
  async function open(): Promise<ShoppingStore> {
    const db = new ShoppingDb('uniover-shopping-test', { indexedDB, IDBKeyRange: FakeIDBKeyRange });
    const store = new ShoppingStore(db, server, {
      online: () => online,
      canSend: () => canSend,
      now: () => 1_700_000_000_000,
      newId: () => `op-${++ids}`,
    });
    stores.push(store);
    await store.load();
    return store;
  }

  const names = (store: ShoppingStore): string[] =>
    listSections(store.snapshot())
      .flatMap((section) => section.rows)
      .map((row) => row.product.name);

  async function addToList(store: ShoppingStore, key: string, name: string): Promise<void> {
    await store.enqueue('product', key, { name, section: '' });
    await store.enqueue('listItem', `li-${key}`, { productId: key, quantity: 1, needed: true });
  }

  beforeEach(() => {
    indexedDB = new FakeIDBFactory();
    server = new FakeServer();
    online = true;
    canSend = true;
    ids = 0;
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it('shows a write at once and keeps it across a restart while there is no signal', async () => {
    online = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');

    expect(names(store)).toEqual(['Leite']);
    expect(store.state()).toBe('offline');
    expect(server.batches).toEqual([]);

    // O app fecha sem ter enviado nada e abre de novo, ainda sem sinal.
    await store.settled();
    store.close();
    const reopened = await open();

    expect(names(reopened)).toEqual(['Leite']);
    expect(reopened.pendingCount()).toBe(2);
    expect(reopened.state()).toBe('offline');
  });

  it('sends the queue in the order it was written when the signal comes back, then follows the feed', async () => {
    online = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await addToList(store, 'bread', 'Pão');

    online = true;
    await store.sync();

    expect(server.batches).toEqual([['milk', 'li-milk', 'bread', 'li-bread']]);
    expect(store.pendingCount()).toBe(0);
    expect(store.state()).toBe('synced');
    expect(names(store)).toEqual(['Pão', 'Leite']);
  });

  it('keeps the confirmed list across a restart: the snapshot is stored with the cursor', async () => {
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await store.settled();
    store.close();
    server.changesCalls = [];

    online = false;
    const reopened = await open();

    expect(names(reopened)).toEqual(['Leite']);
    online = true;
    await reopened.sync();
    expect(server.changesCalls).toEqual([2]);
  });

  it('resends the same operations after a lost response, and the server applies each one once', async () => {
    online = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');

    online = true;
    server.loseResponse = true;
    await store.sync();

    expect(server.applied).toEqual(['op-1', 'op-2']);
    expect(store.state()).toBe('attention');
    expect(store.pendingCount()).toBe(2);

    await store.sync();

    expect(store.pendingCount()).toBe(0);
    expect(server.applied).toEqual(['op-1', 'op-2']);
    expect(server.feed).toHaveLength(2);
    expect(names(store)).toEqual(['Leite']);
  });

  it('drops what the server refused and shows what the server says instead', async () => {
    online = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await addToList(store, 'bread', 'Pão');
    expect(names(store)).toEqual(['Pão', 'Leite']);

    server.refuse = new Set(['bread', 'li-bread']);
    online = true;
    await store.sync();

    expect(store.pendingCount()).toBe(0);
    expect(store.state()).toBe('synced');
    expect(names(store)).toEqual(['Leite']);
  });

  it('keeps what the server could not take now, without holding back what it applied', async () => {
    online = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await addToList(store, 'bread', 'Pão');

    server.later = new Set(['li-milk']);
    online = true;
    await store.sync();

    expect(store.pendingCount()).toBe(1);
    expect(store.state()).toBe('attention');
    expect(names(store)).toEqual(['Pão', 'Leite']);

    server.later.clear();
    await store.sync();

    expect(store.pendingCount()).toBe(0);
    expect(store.state()).toBe('synced');
  });

  it('never sends more than the batch limit at a time and empties a long queue in order', async () => {
    online = false;
    const store = await open();
    const total = BATCH_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) {
      await store.enqueue('product', `p${i}`, { name: `Produto ${i}`, section: '' });
    }

    online = true;
    await store.sync();

    expect(server.batches.map((batch) => batch.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 5]);
    expect(server.batches.flat()).toEqual(Array.from({ length: total }, (_, i) => `p${i}`));
    expect(store.pendingCount()).toBe(0);
  });

  it('sends nothing while the session in hand is not confirmed as this account', async () => {
    canSend = false;
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await store.settled();

    expect(server.batches).toEqual([]);
    expect(server.changesCalls).toEqual([]);
    expect(store.pendingCount()).toBe(2);

    canSend = true;
    await store.sync();

    expect(store.pendingCount()).toBe(0);
  });

  it('starts over when the person is now in another group: nothing of the old one stays', async () => {
    const store = await open();
    await addToList(store, 'milk', 'Leite');
    await store.settled();
    expect(names(store)).toEqual(['Leite']);

    server.groupId = 'group-2';
    server.feed = [
      {
        sequence: 1,
        entityType: 'product',
        entityId: 'tea',
        payload: { name: 'Chá', section: '' },
      },
      {
        sequence: 2,
        entityType: 'listItem',
        entityId: 'li-tea',
        payload: { productId: 'tea', quantity: 1, needed: true, deleted: false },
      },
    ];
    await store.sync();

    expect(names(store)).toEqual(['Chá']);
    await store.settled();
    store.close();
    online = false;
    expect(names(await open())).toEqual(['Chá']);
  });

  it('marks a purchase opened here as unconfirmed until the server answers', async () => {
    online = false;
    const store = await open();
    await store.enqueue('openPurchase', 'purchase-1', {});

    expect(store.unconfirmedPurchase()).toBe('purchase-1');

    online = true;
    await store.sync();

    expect(store.unconfirmedPurchase()).toBeNull();
  });

  it('runs one sync at a time: a write made during a send goes in the next one', async () => {
    online = false;
    const store = await open();
    await store.enqueue('product', 'milk', { name: 'Leite', section: '' });

    online = true;
    const first = store.sync();
    await store.enqueue('product', 'bread', { name: 'Pão', section: '' });
    await first;
    await store.settled();

    expect(server.batches.flat()).toEqual(['milk', 'bread']);
    expect(server.applied).toHaveLength(2);
  });
});
