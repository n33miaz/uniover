import { marketRows, openPurchase } from './shopping-model';
import type { ShoppingStore } from './shopping-store';
import { storeBench, type StoreBench } from './shopping-test-kit';

describe('ShoppingStore: a purchase opened without signal', () => {
  let bench: StoreBench;

  beforeEach(() => {
    bench = storeBench();
  });

  afterEach(() => bench.close());

  /** A lista da casa já está no servidor e no aparelho: leite e pão. */
  async function withList(): Promise<ShoppingStore> {
    const store = await bench.open();
    for (const [key, name] of [
      ['milk', 'Leite'],
      ['bread', 'Pão'],
    ]) {
      await store.enqueue('product', key, { name });
      await store.enqueue('listItem', `li-${key}`, { productId: key, quantity: 1, needed: true });
    }
    await store.settled();
    expect(store.pendingCount()).toBe(0);
    return store;
  }

  const rows = (store: ShoppingStore) => {
    const purchase = openPurchase(store.snapshot());
    return purchase
      ? marketRows(store.snapshot(), purchase).map((row) => ({
          name: row.product.name,
          picked: row.picked,
          price: row.unitPrice,
        }))
      : [];
  };

  const serverLines = () =>
    bench.server.rowsOf('purchaseItem').map((row) => ({
      id: row.id,
      purchase: row.payload['purchaseId'],
      product: row.payload['productId'],
      picked: row.payload['picked'],
      price: row.payload['unitPrice'],
    }));

  it('opens, marks and prices on the device, and lands on the lines the server creates', async () => {
    const store = await withList();
    const before = bench.server.batches.length;
    bench.online = false;

    await store.enqueue('openPurchase', 'mine', {});
    await store.enqueue(
      'purchaseItem',
      'local-milk',
      { productId: 'milk', quantity: 1, unitPrice: null, picked: true },
      'mine',
    );
    await store.enqueue(
      'purchaseItem',
      'local-milk',
      { productId: 'milk', quantity: 1, unitPrice: 4.5, picked: true },
      'mine',
    );
    await store.settled();

    expect(store.unconfirmedPurchase()).toBe('mine');
    expect(rows(store)).toEqual([
      { name: 'Pão', picked: false, price: null },
      { name: 'Leite', picked: true, price: 4.5 },
    ]);
    expect(bench.server.batches).toHaveLength(before);

    bench.online = true;
    await store.sync();
    await store.settled();

    // A abertura vai sozinha; o que foi marcado só segue depois de o aparelho ver as linhas do servidor.
    expect(bench.server.batches[before]).toEqual(['openPurchase:mine']);
    expect(bench.server.batches[before + 1]).toEqual([
      'purchaseItem:server-line-1',
      'purchaseItem:server-line-1',
    ]);
    expect(store.pendingCount()).toBe(0);
    expect(store.state()).toBe('synced');
    expect(store.notice()).toBeNull();
    expect(store.unconfirmedPurchase()).toBeNull();
    expect(serverLines()).toEqual([
      { id: 'server-line-1', purchase: 'mine', product: 'milk', picked: true, price: 4.5 },
      { id: 'server-line-2', purchase: 'mine', product: 'bread', picked: false, price: null },
    ]);
    expect(rows(store)).toEqual([
      { name: 'Pão', picked: false, price: null },
      { name: 'Leite', picked: true, price: 4.5 },
    ]);
  });

  it('adopts the purchase the group already had open and takes the marks to it, never a second one', async () => {
    const store = await withList();
    bench.online = false;
    await store.enqueue('openPurchase', 'mine', {});
    await store.enqueue('budget', 'mine', { budget: 80 });
    await store.enqueue(
      'purchaseItem',
      'local-bread',
      { productId: 'bread', quantity: 1, unitPrice: 7, picked: true },
      'mine',
    );
    await store.enqueue('closePurchase', 'mine', { totalPaid: 7 });
    await store.settled();

    // Enquanto isso, outra pessoa do grupo abriu a compra no servidor (com as linhas dela).
    bench.server.put('purchase', 'theirs', { status: 'open', deleted: false });
    bench.server.put('purchaseItem', 'their-bread', {
      purchaseId: 'theirs',
      productId: 'bread',
      quantity: 1,
      unitPrice: null,
      picked: false,
      deleted: false,
    });

    bench.online = true;
    await store.sync();
    await store.settled();

    const purchases = bench.server.rowsOf('purchase');
    expect(purchases.map((row) => row.id)).toEqual(['theirs']);
    expect(purchases[0].payload).toMatchObject({ status: 'open', budget: 80 });
    expect(serverLines()).toEqual([
      { id: 'their-bread', purchase: 'theirs', product: 'bread', picked: true, price: 7 },
    ]);
    // O fechamento não vai junto: a compra é de todos, e a pessoa é avisada.
    expect(store.pendingCount()).toBe(0);
    expect(store.notice()).toBe('merged');
    expect(openPurchase(store.snapshot())?.id).toBe('theirs');
    expect(rows(store)).toEqual([
      { name: 'Leite', picked: false, price: null },
      { name: 'Pão', picked: true, price: 7 },
    ]);
  });

  it('keeps the marks across a restart and a send that fails halfway', async () => {
    const store = await withList();
    bench.online = false;
    await store.enqueue('openPurchase', 'mine', {});
    await store.enqueue(
      'purchaseItem',
      'local-milk',
      { productId: 'milk', quantity: 1, unitPrice: null, picked: true },
      'mine',
    );
    await store.settled();
    store.close();

    const reopened = await bench.open();
    expect(rows(reopened)).toContainEqual({ name: 'Leite', picked: true, price: null });

    // A abertura chega, mas a rede cai antes de o aparelho ler as linhas do servidor.
    bench.online = true;
    const changes = bench.server.changes.bind(bench.server);
    bench.server.changes = () => Promise.reject(new Error('sem rede'));
    await reopened.sync();
    await reopened.settled();
    expect(reopened.pendingCount()).toBe(1);
    expect(reopened.state()).toBe('attention');

    bench.server.changes = changes;
    await reopened.sync();
    await reopened.settled();

    expect(reopened.pendingCount()).toBe(0);
    expect(reopened.notice()).toBeNull();
    expect(serverLines()).toContainEqual({
      id: 'server-line-1',
      purchase: 'mine',
      product: 'milk',
      picked: true,
      price: null,
    });
    expect(serverLines()).toHaveLength(2);
  });

  it('a tap made while the opening is still being sent lands on the line the server created', async () => {
    const store = await withList();
    const send = bench.server.send.bind(bench.server);
    let tap: Promise<void> | null = null;
    bench.server.send = async (operations) => {
      const results = await send(operations);
      if (!tap && operations.some((operation) => operation.kind === 'openPurchase')) {
        tap = store.enqueue(
          'purchaseItem',
          'local-milk',
          { productId: 'milk', quantity: 1, unitPrice: 4.5, picked: true },
          'mine',
        );
      }
      return results;
    };

    await store.enqueue('openPurchase', 'mine', {});
    await store.settled();
    await tap;
    await store.settled();

    expect(store.pendingCount()).toBe(0);
    expect(store.notice()).toBeNull();
    expect(serverLines()).toEqual([
      { id: 'server-line-1', purchase: 'mine', product: 'milk', picked: true, price: 4.5 },
      { id: 'server-line-2', purchase: 'mine', product: 'bread', picked: false, price: null },
    ]);
    expect(rows(store)).toHaveLength(2);
  });

  it('keeps on the screen what the server has just accepted while the feed is on its way', async () => {
    const store = await withList();
    const changes = bench.server.changes.bind(bench.server);
    const seen: (string | undefined)[] = [];
    bench.server.changes = (after) => {
      // Neste ponto a abertura já saiu da fila e o feed ainda não chegou.
      seen.push(openPurchase(store.snapshot())?.id);
      return changes(after);
    };

    await store.enqueue('openPurchase', 'mine', {});
    await store.settled();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === 'mine')).toBe(true);
    expect(rows(store)).toHaveLength(2);
  });

  it('a second opening of the same trip (a double tap) changes nothing and warns of nothing', async () => {
    const store = await withList();
    bench.online = false;
    await store.enqueue('openPurchase', 'mine', {});
    await store.enqueue('openPurchase', 'again', {});
    await store.settled();

    bench.online = true;
    await store.sync();
    await store.settled();

    expect(bench.server.rowsOf('purchase').map((row) => row.id)).toEqual(['mine']);
    expect(store.pendingCount()).toBe(0);
    expect(store.notice()).toBeNull();
    expect(openPurchase(store.snapshot())?.id).toBe('mine');
  });

  it('says so when the server refuses a change, and undoes it on the screen', async () => {
    const store = await withList();
    await store.enqueue('budget', 'no-such-purchase', { budget: 10 });
    await store.settled();

    expect(store.pendingCount()).toBe(0);
    expect(store.notice()).toBe('refused');
    expect(store.state()).toBe('synced');

    // A próxima mudança da pessoa leva o recado embora.
    await store.enqueue('listItem', 'li-milk', { productId: 'milk', quantity: 2, needed: true });
    expect(store.notice()).toBeNull();
  });
});
