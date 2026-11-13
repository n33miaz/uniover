import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { problemOf } from '../../core/auth/api-problem';
import { ShoppingDb } from './shopping-db';
import { SHOPPING_REQUEST_TIMEOUT_MS, httpShoppingTransport } from './shopping-session';
import { ShoppingStore } from './shopping-store';

const isOperations = (url: string) => url.endsWith('/v1/shopping/operations');
const isChanges = (url: string) => url.includes('/v1/shopping/changes');

describe('httpShoppingTransport', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // Só o relógio do prazo é falso: o banco do aparelho (fake-indexeddb) segue no relógio de verdade.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a request left hanging is cancelled at the deadline and counts as no answer', async () => {
    const transport = httpShoppingTransport(TestBed.inject(HttpClient));
    const sending = transport.send([]);
    const outcome = sending.then(
      () => null,
      (error: unknown) => error,
    );
    const request = http.expectOne((candidate) => isOperations(candidate.url));

    await vi.advanceTimersByTimeAsync(SHOPPING_REQUEST_TIMEOUT_MS - 100);
    expect(request.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    expect(request.cancelled).toBe(true);
    expect(problemOf(await outcome)?.isNetwork).toBe(true);
  });

  it('a hanging send does not leave the list stuck on "Salvando": it is freed and the next attempt sends', async () => {
    const db = new ShoppingDb('uniover-shopping-transport-test', {
      indexedDB: new FakeIDBFactory(),
      IDBKeyRange: FakeIDBKeyRange,
    });
    let ids = 0;
    const store = new ShoppingStore(db, httpShoppingTransport(TestBed.inject(HttpClient)), {
      online: () => true,
      canSend: () => true,
      now: () => 1_700_000_000_000,
      newId: () => `op-${++ids}`,
    });
    await store.load();
    await store.enqueue('product', 'milk', { name: 'Leite', section: '' });

    const hanging = await vi.waitFor(() =>
      http.expectOne((candidate) => isOperations(candidate.url)),
    );
    expect(store.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(SHOPPING_REQUEST_TIMEOUT_MS);
    await store.settled();
    expect(hanging.cancelled).toBe(true);
    expect(store.state()).toBe('attention');
    expect(store.pendingCount()).toBe(1);

    // A tentativa seguinte (a pessoa tocou ou a rede voltou) sai e esvazia a fila.
    const again = store.sync();
    const send = await vi.waitFor(() => http.expectOne((candidate) => isOperations(candidate.url)));
    const body = send.request.body as { operations: { operationId: string }[] };
    send.flush(
      body.operations.map((operation) => ({ operationId: operation.operationId, status: 200 })),
    );
    const pull = await vi.waitFor(() => http.expectOne((candidate) => isChanges(candidate.url)));
    pull.flush({ groupId: 'group-1', items: [], nextCursor: 0, hasMore: false });
    await again;
    await store.settled();
    expect(store.pendingCount()).toBe(0);
    expect(store.state()).toBe('synced');
    store.close();
  });
});
