import {
  listSections,
  marketRows,
  openPurchase,
  settleQueue,
  type PendingOperation,
} from './shopping-model';
import {
  LIVE_FAST_FOR_MS,
  LIVE_IDLE_AFTER_MS,
  LIVE_INTERVAL_MS,
  LIVE_SLOW_INTERVAL_MS,
  LiveWatch,
} from './shopping-session';
import { ShoppingDb } from './shopping-db';
import type { ShoppingStore } from './shopping-store';
import { storeBench, type StoreBench } from './shopping-test-kit';

describe('ShoppingStore: two phones without signal', () => {
  let bench: StoreBench;

  beforeEach(() => {
    bench = storeBench();
  });

  afterEach(() => bench.close());

  const names = (store: ShoppingStore): string[] =>
    [...store.snapshot().products.values()]
      .filter((product) => !product.deleted)
      .map((product) => product.name);

  const listed = (store: ShoppingStore) =>
    listSections(store.snapshot()).flatMap((section) =>
      section.rows.map((row) => ({ name: row.product.name, quantity: row.item.quantity })),
    );

  const lines = (store: ShoppingStore) => {
    const purchase = openPurchase(store.snapshot());
    return purchase
      ? marketRows(store.snapshot(), purchase).map((row) => ({
          name: row.product.name,
          picked: row.picked,
          price: row.unitPrice,
        }))
      : [];
  };

  async function addMilk(store: ShoppingStore, key: string, quantity = 1): Promise<void> {
    await store.enqueue('product', `milk-${key}`, { name: key === 'a' ? 'Leite' : 'leite' });
    await store.enqueue('listItem', `item-${key}`, {
      productId: `milk-${key}`,
      quantity,
      needed: true,
      only: 'needed',
    });
  }

  it('the same product added on both ends up once, with nothing refused and nothing lost', async () => {
    const first = await bench.open('a');
    const second = await bench.open('b');
    bench.online = false;
    await addMilk(first, 'a');
    await addMilk(second, 'b', 3);
    await second.enqueue('product', 'bread', { name: 'Pão' });
    await second.enqueue('listItem', 'item-bread', {
      productId: 'bread',
      quantity: 1,
      needed: true,
    });
    await Promise.all([first.settled(), second.settled()]);

    bench.online = true;
    await first.sync();
    await first.settled();
    await second.sync();
    await second.settled();
    await first.sync();
    await first.settled();

    expect(bench.server.rowsOf('product').map((row) => row.id)).toEqual(['milk-a', 'bread']);
    expect(bench.server.rowsOf('listItem').map((row) => row.id)).toEqual(['item-a', 'item-bread']);
    for (const store of [first, second]) {
      expect(store.pendingCount()).toBe(0);
      expect(store.state()).toBe('synced');
      expect(names(store).sort()).toEqual(['Leite', 'Pão']);
      expect(listed(store)).toEqual([
        { name: 'Leite', quantity: 3 },
        { name: 'Pão', quantity: 1 },
      ]);
    }
    // Quem chegou depois só fica sabendo que os repetidos viraram um; ninguém vê "recusada".
    expect(first.notice()).toBeNull();
    expect(second.notice()).toBe('joined');
  });

  it('points what is still waiting in the queue at the record that stays', async () => {
    const first = await bench.open('a');
    const second = await bench.open('b');
    bench.online = false;
    await addMilk(first, 'a');
    await addMilk(second, 'b');
    // A abertura da compra fecha o lote: o "peguei" do leite vai num envio seguinte, já com o produto que vale.
    await second.enqueue('openPurchase', 'trip', {});
    await second.enqueue(
      'purchaseItem',
      'line-b',
      { productId: 'milk-b', quantity: 1, unitPrice: 4.5, picked: true },
      'trip',
    );
    await Promise.all([first.settled(), second.settled()]);

    bench.online = true;
    await first.sync();
    await first.settled();
    const sent: PendingOperation[][] = [];
    const send = bench.server.send.bind(bench.server);
    bench.server.send = (operations) => {
      sent.push([...operations]);
      return send(operations);
    };
    await second.sync();
    await second.settled();

    const last = sent[sent.length - 1];
    expect(last.map((operation) => operation.kind)).toEqual(['purchaseItem']);
    expect(last[0].body['productId']).toBe('milk-a');
    expect(second.pendingCount()).toBe(0);
    expect(bench.server.rowsOf('product')).toHaveLength(1);
    expect(bench.server.rowsOf('purchaseItem')).toHaveLength(1);
    expect(lines(second)).toEqual([{ name: 'Leite', picked: true, price: 4.5 }]);
  });

  it('never shows the repeated product twice, not even while the feed is on its way', async () => {
    const first = await bench.open('a');
    const second = await bench.open('b');
    bench.online = false;
    await addMilk(first, 'a');
    await addMilk(second, 'b');
    await Promise.all([first.settled(), second.settled()]);
    bench.online = true;
    await first.sync();
    await first.settled();

    const seen: number[] = [];
    const changes = bench.server.changes.bind(bench.server);
    bench.server.changes = (after) => {
      seen.push(names(second).length, listed(second).length);
      return changes(after);
    };
    await second.sync();
    await second.settled();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 1)).toBe(true);
    expect(listed(second)).toHaveLength(1);
  });

  it('a batch whose answer was lost goes again and still ends with one of each', async () => {
    const first = await bench.open('a');
    const second = await bench.open('b');
    bench.online = false;
    await addMilk(first, 'a');
    await addMilk(second, 'b');
    await Promise.all([first.settled(), second.settled()]);
    bench.online = true;
    await first.sync();
    await first.settled();

    const send = bench.server.send.bind(bench.server);
    let lost = false;
    bench.server.send = async (operations) => {
      const results = await send(operations);
      if (!lost) {
        lost = true;
        throw new Error('a resposta se perdeu');
      }
      return results;
    };
    await second.sync();
    await second.settled();
    expect(second.pendingCount()).toBe(2);

    await second.sync();
    await second.settled();

    expect(second.pendingCount()).toBe(0);
    expect(second.notice()).toBe('joined');
    expect(bench.server.rowsOf('product')).toHaveLength(1);
    expect(bench.server.rowsOf('listItem')).toHaveLength(1);
    expect(listed(second)).toEqual([{ name: 'Leite', quantity: 1 }]);
  });

  it('the same line created on both keeps the tap of one and the price of the other', async () => {
    const first = await bench.open('a');
    await addMilk(first, 'a');
    await first.settled();
    bench.server.put('purchase', 'trip', { status: 'open', deleted: false });
    const second = await bench.open('b');
    await Promise.all([first.sync(), second.sync()]);
    await Promise.all([first.settled(), second.settled()]);

    // Os dois veem a compra sem linha para o leite e, sem sinal, cada um cria a sua.
    bench.online = false;
    await first.enqueue(
      'purchaseItem',
      'line-a',
      { productId: 'milk-a', quantity: 1, unitPrice: 6, picked: false, only: 'price' },
      'trip',
    );
    bench.clock += 60_000;
    await second.enqueue(
      'purchaseItem',
      'line-b',
      { productId: 'milk-a', quantity: 1, unitPrice: null, picked: true, only: 'picked' },
      'trip',
    );
    await second.enqueue(
      'purchaseItem',
      'line-b',
      { productId: 'milk-a', quantity: 1, unitPrice: null, picked: false, only: 'picked' },
      'trip',
    );
    await second.enqueue(
      'purchaseItem',
      'line-b',
      { productId: 'milk-a', quantity: 1, unitPrice: null, picked: true, only: 'picked' },
      'trip',
    );
    await Promise.all([first.settled(), second.settled()]);

    // Os dois passam juntos pela conferência das linhas e só então enviam: é a corrida que o servidor resolve.
    bench.online = true;
    const send = bench.server.send.bind(bench.server);
    let release = (): void => undefined;
    const both = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    bench.server.send = async (operations) => {
      if (++waiting === 2) release();
      await both;
      return send(operations);
    };
    await Promise.all([first.sync(), second.sync()]);
    await Promise.all([first.settled(), second.settled()]);
    await first.sync();
    await first.settled();

    expect(bench.server.rowsOf('purchaseItem')).toHaveLength(1);
    for (const store of [first, second]) {
      expect(store.pendingCount()).toBe(0);
      expect(store.notice()).not.toBe('refused');
      expect(lines(store)).toEqual([{ name: 'Leite', picked: true, price: 6 }]);
    }
  });

  it('deleting what was created here and never sent drops the pair, keeping the rest of the queue in order', async () => {
    const first = await bench.open('a');
    await addMilk(first, 'a');
    await first.settled();
    const second = await bench.open('b');
    bench.online = false;
    await second.enqueue('product', 'coffee', { name: 'Café' });
    await second.enqueue('product', 'milk-b', { name: 'leite' });
    await second.enqueue('product', 'milk-b', { name: 'leite integral' });
    await second.enqueue('product', 'sugar', { name: 'Açúcar' });
    // O item do café depende do produto: apagar o café com ele na fila não descarta nada.
    await second.enqueue('listItem', 'item-coffee', {
      productId: 'coffee',
      quantity: 1,
      needed: true,
    });
    await second.enqueue('product', 'milk-b', { name: 'leite', deleted: true });
    await second.enqueue('product', 'coffee', { name: 'Café', deleted: true });
    await second.settled();

    const db = new ShoppingDb('uniover-shopping-b', bench.idb);
    const stored = await db.operations.orderBy('seq').toArray();
    db.close();
    expect(stored.map((operation) => `${operation.kind}:${operation.entityId}`)).toEqual([
      'product:coffee',
      'product:sugar',
      'listItem:item-coffee',
      'product:coffee',
    ]);
    expect(second.pendingCount()).toBe(4);

    bench.online = true;
    await second.sync();
    await second.settled();
    expect(bench.server.batches.flat().some((sent) => sent.endsWith(':milk-b'))).toBe(false);
    const milk = bench.server.rowsOf('product').find((row) => row.id === 'milk-a');
    expect(milk?.payload['deleted']).toBe(false);
    expect(names(second).sort()).toEqual(['Açúcar', 'Leite']);
  });

  it('never drops a creation that already left the phone: its delete goes by the old id and the record that stayed is kept', async () => {
    const first = await bench.open('a');
    await addMilk(first, 'a');
    await first.settled();
    const second = await bench.open('b');

    // O servidor aplicou a criação (juntou ao leite do outro), mas a resposta se perdeu.
    const send = bench.server.send.bind(bench.server);
    let lost = false;
    bench.server.send = async (operations) => {
      const results = await send(operations);
      if (!lost) {
        lost = true;
        throw new Error('a resposta se perdeu');
      }
      return results;
    };
    await second.enqueue('product', 'milk-b', { name: 'leite' });
    await second.settled();
    expect(second.pendingCount()).toBe(1);

    await second.enqueue('product', 'milk-b', { name: 'leite', deleted: true });
    await second.settled();

    expect(second.pendingCount()).toBe(0);
    const milk = bench.server.rowsOf('product').find((row) => row.id === 'milk-a');
    expect(milk?.payload['deleted']).toBe(false);
    expect(names(second)).toEqual(['Leite']);
  });

  it('counts each change seen here, and an empty look at the feed is not one', async () => {
    const store = await bench.open();
    await store.sync();
    await store.settled();
    const start = store.activity();

    await store.sync();
    await store.settled();
    expect(store.activity()).toBe(start);

    bench.server.put('product', 'rice', { name: 'Arroz', section: '', deleted: false });
    await store.sync();
    await store.settled();
    expect(store.activity()).toBeGreaterThan(start);

    const before = store.activity();
    await store.enqueue('product', 'beans', { name: 'Feijão' });
    expect(store.activity()).toBeGreaterThan(before);
  });

  it('knows there is someone else in the group, and remembers it after a restart', async () => {
    const store = await bench.open();
    await store.sync();
    await store.settled();
    expect(store.shared()).toBe(false);

    bench.server.put('member', 'guest', { userId: 'guest', isOwner: false, deleted: false });
    await store.sync();
    await store.settled();
    expect(store.shared()).toBe(true);
    store.close();

    const reopened = await bench.open();
    expect(reopened.shared()).toBe(true);

    bench.server.put('member', 'guest', { userId: 'guest', isOwner: false, deleted: true });
    await reopened.sync();
    await reopened.settled();
    expect(reopened.shared()).toBe(false);
  });
});

describe('ShoppingStore: a phone that already had the list before people were remembered', () => {
  it('finds out once that there is someone else in the group', async () => {
    const bench = storeBench();
    bench.server.put('member', 'guest', { userId: 'guest', isOwner: false, deleted: false });
    const store = await bench.open();
    await store.sync();
    await store.settled();
    store.close();

    // Como a versão anterior deixou o banco: o cursor já passou pela pessoa, e ninguém foi guardado.
    const old = new ShoppingDb('uniover-shopping-test', bench.idb);
    await old.meta.delete('others');
    old.close();

    const reopened = await bench.open();
    expect(reopened.shared()).toBe(false);
    await reopened.sync();
    await reopened.settled();
    expect(reopened.shared()).toBe(true);
    reopened.close();

    const again = await bench.open();
    expect(again.shared()).toBe(true);
    bench.close();
  });
});

describe('settleQueue', () => {
  const operation = (
    id: string,
    kind: PendingOperation['kind'],
    entityId: string,
    body: Record<string, unknown>,
    purchaseId?: string,
  ): PendingOperation => ({
    id,
    kind,
    entityId,
    body,
    createdAt: 0,
    ...(purchaseId ? { purchaseId } : {}),
  });

  it('repoints records and products, moves the trip, and leaves the rest untouched', () => {
    const queue = [
      operation('1', 'listItem', 'item-b', { productId: 'milk-b', needed: true }),
      operation('2', 'purchaseItem', 'line-b', { productId: 'milk-b', picked: true }, 'mine'),
      operation('3', 'listItem', 'item-bread', { productId: 'bread', needed: true }),
      operation('4', 'closePurchase', 'mine', { totalPaid: 1 }),
    ];
    const ids = new Map([
      ['milk-b', 'milk-a'],
      ['item-b', 'item-a'],
    ]);

    const settled = settleQueue(queue, ids, { from: 'mine', to: 'theirs' });

    expect(settled.changed).toEqual([
      operation('1', 'listItem', 'item-a', { productId: 'milk-a', needed: true }),
      operation('2', 'purchaseItem', 'line-b', { productId: 'milk-a', picked: true }, 'theirs'),
    ]);
    expect(settled.dropped.map((dropped) => dropped.id)).toEqual(['4']);
    expect(settleQueue(queue, new Map(), null)).toEqual({ changed: [], dropped: [] });
  });

  it('leaves a delete on the id from here: by the id that stayed, it would delete the record of someone else', () => {
    const queue = [
      operation('1', 'product', 'milk-b', { name: 'leite', deleted: true }),
      operation('2', 'listItem', 'item-b', { productId: 'milk-b', deleted: true }),
    ];
    const ids = new Map([
      ['milk-b', 'milk-a'],
      ['item-b', 'item-a'],
    ]);

    expect(settleQueue(queue, ids, null).changed).toEqual([
      operation('2', 'listItem', 'item-b', { productId: 'milk-a', deleted: true }),
    ]);
  });
});

describe('LiveWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks every few seconds only with someone else in the group, the screen in view and signal', () => {
    let ticks = 0;
    const watch = new LiveWatch(() => ticks++);

    watch.set(false, true, true);
    watch.set(true, false, true);
    watch.set(true, true, false);
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    watch.set(true, true, true);
    watch.set(true, true, true);
    vi.advanceTimersByTime(LIVE_INTERVAL_MS * 3);
    expect(ticks).toBe(3);

    // A tela saiu de vista: nenhuma consulta e nenhum temporizador ficam para trás.
    watch.set(true, false, true);
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(3);
    expect(vi.getTimerCount()).toBe(0);

    watch.set(true, true, true);
    watch.stop();
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(3);
    expect(LIVE_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });

  it('asks every few seconds right after a change, then less often, then stops until someone looks', () => {
    let ticks = 0;
    const watch = new LiveWatch(() => ticks++);
    watch.set(true, true, true);

    vi.advanceTimersByTime(LIVE_FAST_FOR_MS);
    expect(ticks).toBe(LIVE_FAST_FOR_MS / LIVE_INTERVAL_MS);

    vi.advanceTimersByTime(LIVE_IDLE_AFTER_MS - LIVE_FAST_FOR_MS);
    const slow = (LIVE_IDLE_AFTER_MS - LIVE_FAST_FOR_MS) / LIVE_SLOW_INTERVAL_MS;
    expect(ticks).toBe(LIVE_FAST_FOR_MS / LIVE_INTERVAL_MS + slow);
    // Dez minutos sem mudança: nada mais é consultado, nem fica temporizador no ar (a aba esquecida aberta).
    expect(vi.getTimerCount()).toBe(0);
    const stopped = ticks;
    vi.advanceTimersByTime(60 * 60_000);
    expect(ticks).toBe(stopped);

    // A pessoa tocou na tela: volta o ritmo rápido.
    watch.wake();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(ticks).toBe(stopped + 1);

    // No ritmo lento, uma mudança (daqui ou do feed) traz de volta o rápido.
    vi.advanceTimersByTime(LIVE_FAST_FOR_MS);
    const before = ticks;
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(ticks).toBe(before);
    watch.changed();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(ticks).toBe(before + 1);

    // Tocar com a consulta em curso não muda o ritmo.
    watch.wake();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS - 1);
    expect(ticks).toBe(before + 1);
    watch.stop();
  });

  it('never asks with the screen hidden, not even after a change or a touch', () => {
    let ticks = 0;
    const watch = new LiveWatch(() => ticks++);
    watch.set(true, false, true);
    watch.changed();
    watch.wake();
    vi.advanceTimersByTime(LIVE_IDLE_AFTER_MS);
    expect(ticks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // De volta à tela depois de muito tempo parada: nada até a pessoa olhar (a volta à aba chama `wake`).
    watch.set(true, true, true);
    expect(vi.getTimerCount()).toBe(0);
    watch.wake();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(ticks).toBe(1);
    watch.stop();
  });
});
