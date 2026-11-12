import {
  adoptPurchase,
  alignLines,
  applyChanges,
  budgetState,
  classifyResult,
  closedPurchases,
  emptySnapshot,
  findProduct,
  listSections,
  marketRows,
  openPurchase,
  parseMoney,
  pickedTotal,
  project,
  suggestProducts,
  type Change,
  type PendingOperation,
  type Snapshot,
} from './shopping-model';

let sequence = 0;
function change(entityType: string, entityId: string, payload: object): Change {
  sequence += 1;
  return { sequence, entityType, entityId, payload };
}

function operation(
  kind: PendingOperation['kind'],
  entityId: string,
  body: Record<string, unknown>,
  purchaseId?: string,
): PendingOperation {
  sequence += 1;
  return { id: `op-${sequence}`, kind, entityId, body, createdAt: 1_700_000_000_000, purchaseId };
}

/** Leite e pão na lista (o pão sem seção), arroz conhecido mas fora da lista. */
function house(): Snapshot {
  return applyChanges(emptySnapshot(), [
    change('product', 'milk', { name: 'Leite', section: 'Frios', deleted: false }),
    change('product', 'bread', { name: 'Pão', section: '', deleted: false }),
    change('product', 'rice', { name: 'Arroz', section: 'Mercearia', deleted: false }),
    change('listItem', 'li-milk', { productId: 'milk', quantity: 2, needed: true, deleted: false }),
    change('listItem', 'li-bread', {
      productId: 'bread',
      quantity: 1,
      needed: true,
      deleted: false,
    }),
    change('listItem', 'li-rice', {
      productId: 'rice',
      quantity: 1,
      needed: false,
      deleted: false,
    }),
  ]);
}

describe('applyChanges', () => {
  it('keeps the last change of each record and ignores what the screen does not show', () => {
    const snapshot = applyChanges(house(), [
      change('product', 'milk', { name: 'Leite integral', section: 'Frios', deleted: false }),
      change('member', 'someone', { userId: 'someone', deleted: false }),
      change('product', 'broken', null as unknown as object),
    ]);

    expect(snapshot.products.get('milk')?.name).toBe('Leite integral');
    expect(snapshot.products.size).toBe(3);
  });

  it('does not change the snapshot it received', () => {
    const before = house();
    applyChanges(before, [
      change('product', 'milk', { name: 'Outro', section: '', deleted: false }),
    ]);

    expect(before.products.get('milk')?.name).toBe('Leite');
  });

  it('hides a tombstone from the list', () => {
    const snapshot = applyChanges(house(), [
      change('listItem', 'li-milk', {
        productId: 'milk',
        quantity: 2,
        needed: true,
        deleted: true,
      }),
    ]);

    expect(
      listSections(snapshot)
        .flatMap((s) => s.rows)
        .map((r) => r.product.name),
    ).toEqual(['Pão']);
  });
});

describe('listSections', () => {
  it('shows only what is needed, by section, the unnamed section last', () => {
    expect(listSections(house()).map((s) => [s.name, s.rows.map((r) => r.product.name)])).toEqual([
      ['Frios', ['Leite']],
      ['', ['Pão']],
    ]);
  });
});

describe('project (pending writes over the server snapshot)', () => {
  it('shows a product and its list item before the server knows them', () => {
    const snapshot = project(house(), [
      operation('product', 'eggs', { name: 'Ovos' }),
      operation('listItem', 'li-eggs', { productId: 'eggs', quantity: 1, needed: true }),
    ]);

    expect(
      listSections(snapshot)
        .flatMap((s) => s.rows)
        .map((r) => r.product.name),
    ).toEqual(['Leite', 'Ovos', 'Pão']);
  });

  it('applies the writes in the order they were made: the last touch wins', () => {
    const body = { productId: 'milk', quantity: 2 };
    const snapshot = project(house(), [
      operation('listItem', 'li-milk', { ...body, needed: false }),
      operation('listItem', 'li-milk', { ...body, needed: true }),
      operation('listItem', 'li-milk', { ...body, needed: false }),
    ]);

    expect(snapshot.listItems.get('li-milk')?.needed).toBe(false);
  });

  it('closing a purchase clears from the list what was picked, and only that', () => {
    const open = applyChanges(house(), [
      change('purchase', 'p1', { status: 'open', budget: null, deleted: false }),
      change('purchaseItem', 'l-milk', {
        purchaseId: 'p1',
        productId: 'milk',
        quantity: 2,
        unitPrice: 5,
        picked: true,
        deleted: false,
      }),
      change('purchaseItem', 'l-bread', {
        purchaseId: 'p1',
        productId: 'bread',
        quantity: 1,
        picked: false,
        deleted: false,
      }),
    ]);

    const closed = project(open, [operation('closePurchase', 'p1', { totalPaid: 10 })]);

    expect(openPurchase(closed)).toBeUndefined();
    expect(closedPurchases(closed).map((p) => [p.id, p.totalPaid])).toEqual([['p1', 10]]);
    expect(closed.listItems.get('li-milk')?.needed).toBe(false);
    expect(closed.listItems.get('li-bread')?.needed).toBe(true);
  });

  it('a budget for a purchase that is not there changes nothing', () => {
    const before = house();

    expect(project(before, [operation('budget', 'gone', { budget: 10 })])).toBe(before);
  });
});

describe('marketRows, total and budget', () => {
  function market(): Snapshot {
    return applyChanges(house(), [
      change('purchase', 'p1', { status: 'open', budget: 20, deleted: false }),
      change('purchaseItem', 'l-milk', {
        purchaseId: 'p1',
        productId: 'milk',
        quantity: 2,
        unitPrice: 5.1,
        picked: true,
        deleted: false,
      }),
      change('purchaseItem', 'l-other', {
        purchaseId: 'p2',
        productId: 'rice',
        quantity: 1,
        unitPrice: 99,
        picked: true,
        deleted: false,
      }),
    ]);
  }

  it('lists the lines of the purchase and what is on the list without a line, unpicked first', () => {
    const snapshot = market();
    const rows = marketRows(snapshot, openPurchase(snapshot)!);

    expect(rows.map((r) => [r.product.name, r.lineId, r.picked])).toEqual([
      ['Pão', null, false],
      ['Leite', 'l-milk', true],
    ]);
  });

  it('sums only what was picked and has a price, in cents', () => {
    const snapshot = project(market(), [
      operation(
        'purchaseItem',
        'l-bread',
        { productId: 'bread', quantity: 3, unitPrice: 0.1, picked: true },
        'p1',
      ),
      operation(
        'purchaseItem',
        'l-rice',
        { productId: 'rice', quantity: 1, unitPrice: 7, picked: false },
        'p1',
      ),
    ]);

    // 2 × 5,10 + 3 × 0,10: em ponto flutuante daria 10,500000000000002.
    expect(pickedTotal(marketRows(snapshot, openPurchase(snapshot)!))).toBe(10.5);
  });

  it('says how much is left or how much went over the budget', () => {
    expect(budgetState(10.5, 20)).toEqual({ left: 9.5, over: 0 });
    expect(budgetState(20, 20)).toEqual({ left: 0, over: 0 });
    expect(budgetState(20.3, 20.1)).toEqual({ left: 0, over: 0.2 });
    expect(budgetState(10, null)).toBeNull();
    expect(budgetState(10, undefined)).toBeNull();
  });
});

describe('product names', () => {
  it('finds a product the way the server compares names: no accent, no case, single spaces', () => {
    expect(findProduct(house(), '  PAO ')?.id).toBe('bread');
    expect(findProduct(house(), 'leite   ')?.id).toBe('milk');
    expect(findProduct(house(), 'Leite desnatado')).toBeUndefined();
    expect(findProduct(house(), '   ')).toBeUndefined();
  });

  it('suggests the products of the group that contain the text, never the exact one already typed', () => {
    expect(suggestProducts(house(), 'e').map((p) => p.name)).toEqual(['Leite']);
    expect(suggestProducts(house(), 'ARR').map((p) => p.name)).toEqual(['Arroz']);
    expect(suggestProducts(house(), 'arroz')).toEqual([]);
    expect(suggestProducts(house(), '')).toEqual([]);
  });
});

describe('parseMoney', () => {
  it.each([
    ['12,5', 12.5],
    ['12.50', 12.5],
    [' 7 ', 7],
    ['0', 0],
  ])('reads %s as %d', (text, value) => {
    expect(parseMoney(text)).toBe(value);
  });

  it('an empty field is "no value", not zero', () => {
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney('   ')).toBeUndefined();
  });

  it.each(['abc', '-1', '1,234', '1.2.3', '10000000', '1e3'])('refuses %s', (text) => {
    expect(parseMoney(text)).toBeNull();
  });
});

describe('classifyResult', () => {
  it.each([200, 201, 204])('%d leaves the queue as applied', (status) => {
    expect(classifyResult(status)).toBe('applied');
  });

  it.each([400, 404, 409, 410, 422])(
    '%d leaves the queue as refused: the server decided',
    (status) => {
      expect(classifyResult(status)).toBe('refused');
    },
  );

  it.each([0, 401, 403, 408, 429, 500, 502, 503])(
    '%d stays in the queue for the next attempt',
    (status) => {
      expect(classifyResult(status)).toBe('retry');
    },
  );
});

describe('a purchase opened on the device, settled with the server', () => {
  const line = { productId: 'milk', quantity: 1, unitPrice: null, picked: true };

  it('does not show a second open purchase when the group already has one', () => {
    const server = applyChanges(house(), [
      change('purchase', 'theirs', { status: 'open', deleted: false }),
    ]);
    const snapshot = project(server, [operation('openPurchase', 'mine', {})]);

    expect([...snapshot.purchases.keys()]).toEqual(['theirs']);
  });

  it('moves the items and the ceiling to the purchase of the server, and leaves the closing out', () => {
    const item = operation('purchaseItem', 'local-milk', line, 'mine');
    const budget = operation('budget', 'mine', { budget: 50 });
    const close = operation('closePurchase', 'mine', { totalPaid: 10 });
    const other = operation('listItem', 'li-milk', { productId: 'milk', needed: false });

    const { changed, dropped } = adoptPurchase([item, budget, close, other], 'mine', 'theirs');

    expect(changed).toEqual([
      { ...item, purchaseId: 'theirs' },
      { ...budget, entityId: 'theirs' },
    ]);
    expect(dropped).toEqual([close]);
  });

  it('puts a line made here on the line the server has for the same product', () => {
    const server = applyChanges(house(), [
      change('purchase', 'p1', { status: 'open', deleted: false }),
      change('purchaseItem', 'server-milk', { ...line, purchaseId: 'p1', picked: false }),
    ]);
    const mine = operation('purchaseItem', 'local-milk', line, 'p1');
    const known = operation('purchaseItem', 'server-milk', line, 'p1');

    expect(alignLines(server, [mine, known])).toEqual([{ ...mine, entityId: 'server-milk' }]);
  });

  it('keeps one line per product when the server has none, and waits while the purchase is not there', () => {
    const server = applyChanges(house(), [
      change('purchase', 'p1', { status: 'open', deleted: false }),
    ]);
    const first = operation('purchaseItem', 'a', { ...line, productId: 'rice' }, 'p1');
    const second = operation('purchaseItem', 'b', { ...line, productId: 'rice' }, 'p1');
    const waiting = operation('purchaseItem', 'c', line, 'not-yet');

    expect(alignLines(server, [first, second, waiting])).toEqual([{ ...second, entityId: 'a' }]);
  });
});
