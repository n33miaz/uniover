import { Component, Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from '../auth/auth-api';
import { AuthService } from '../auth/auth.service';
import { SessionState } from '../session/session-state';
import {
  FakeTransport,
  NEW_ITEM,
  createTestDb,
  deferred,
  networkError,
  ok,
  problem,
  setupQueue,
} from './queue-test-kit';
import { OfflineDb } from './offline-db';
import { POLL_INTERVAL_MS, SyncEngine } from './sync-engine';

@Component({ template: '' })
class Blank {}

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

async function listOf(db: OfflineDb) {
  return db.outbox.orderBy('createdAt').toArray();
}

describe('SyncEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setOnline(true);
  });

  /** Primeira passagem (forçada) e o que ela pedir em seguida; devolve quando o motor para. */
  async function settle(kit: ReturnType<typeof setupQueue>) {
    await kit.engine().start();
    await kit.engine().drain();
  }

  it('sends one at a time, oldest first, each with its own Idempotency-Key and JSON content type', async () => {
    const kit = setupQueue();
    const ids = [
      await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } }),
      await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } }),
      await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 3 } }),
    ];
    await settle(kit);

    expect(kit.transport.keys).toEqual(ids);
    expect(kit.transport.requests.map((r) => r.body)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(kit.transport.maxInFlight).toBe(1);
    expect(
      kit.transport.requests.every((r) => r.headers['Content-Type'] === 'application/json'),
    ).toBe(true);
    expect(kit.transport.requests.every((r) => r.method === 'POST' && r.url === NEW_ITEM.url)).toBe(
      true,
    );
    expect(await listOf(kit.db)).toEqual([]);
    expect(kit.queue().pendingCount()).toBe(0);
  });

  it('keeps the same Idempotency-Key in every attempt of the same item', async () => {
    const kit = setupQueue();
    kit.transport.script = [networkError(), ok(503), ok(201)];
    const id = await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);
    for (let i = 0; i < 2; i++) {
      kit.runtime.advance(5 * 60_000);
      await kit.engine().whenIdle();
    }

    expect(kit.transport.keys).toEqual([id, id, id]);
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('removes the item on success, and only if it did not change while in flight', async () => {
    const kit = setupQueue();
    const gate = deferred();
    kit.transport.gate = gate.promise;
    // O 1º envio (corpo velho) é aceito; o do item editado ainda não chega ao servidor.
    kit.transport.script = [ok(201), networkError()];
    const id = await kit.queue().enqueue({ ...NEW_ITEM, body: { v: 'velho' } });

    const first = kit.engine().start();
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(1));
    // Enquanto o envio voa, o usuário edita o corpo do mesmo item.
    await kit.queue().update(id, { v: 'novo' });
    gate.open();
    await first;
    await kit.engine().whenIdle();

    // O 201 era do corpo velho: o item editado continua na fila, com chave nova.
    let rows = await listOf(kit.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toEqual({ v: 'novo' });
    expect(rows[0].id).not.toBe(id);
    expect(rows[0].status).toBe('pending');
    expect(kit.transport.keys[0]).toBe(id);

    await kit.engine().drain({ force: true });
    rows = await listOf(kit.db);
    expect(rows).toEqual([]);
    expect(kit.transport.keys.at(-1)).not.toBe(id);
  });

  it('grows the backoff after each failure and waits before trying again', async () => {
    const kit = setupQueue();
    kit.transport.script = [networkError(), networkError(), networkError(), ok(201)];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);
    expect(kit.transport.requests).toHaveLength(1);

    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [row] = await listOf(kit.db);
      waits.push(row.nextAttemptAt - kit.runtime.now());
      // um segundo antes do prazo ainda não tenta
      kit.runtime.advance(waits[i] - 1_000);
      await kit.engine().whenIdle();
      expect(kit.transport.requests).toHaveLength(1 + i);
      kit.runtime.advance(1_000);
      await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(2 + i));
      await kit.engine().whenIdle();
    }

    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('respects Retry-After on 429', async () => {
    const kit = setupQueue();
    kit.transport.script = [ok(429, { 'retry-after': '30' })];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);

    const [row] = await listOf(kit.db);
    expect(row.status).toBe('pending');
    expect(row.nextAttemptAt - kit.runtime.now()).toBe(30_000);
    expect(row.lastError).toBe('rate-limited');
    expect(kit.queue().failedCount()).toBe(0);
  });

  it('retries a key that is still in progress on the server after a few seconds', async () => {
    const kit = setupQueue();
    kit.transport.script = [problem(409, 'idempotency-in-progress', { 'retry-after': '2' })];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);

    kit.runtime.advance(3_000);
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(2));
    await kit.engine().whenIdle();
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('keeps the item on 401 without failing it, and does not skip ahead of it', async () => {
    const kit = setupQueue();
    kit.transport.fallback = ok(401);
    kit.pause();
    const first = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } });
    await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } });
    kit.resume();
    await settle(kit);

    const rows = await listOf(kit.db);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(rows[0].id).toBe(first);
    expect(rows[0].lastError).toBe('unauthenticated');
    expect(kit.transport.requests).toHaveLength(1);
    expect(kit.queue().failedCount()).toBe(0);
    expect(kit.queue().pendingCount()).toBe(2);
  });

  it('marks a business refusal as failed, keeps it visible and does not block the others', async () => {
    const kit = setupQueue();
    kit.transport.script = [problem(422, 'validation-failed')];
    kit.pause();
    const bad = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } });
    await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } });
    kit.resume();
    await settle(kit);

    const rows = await listOf(kit.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: bad,
      status: 'failed',
      lastError: 'http-422:validation-failed',
    });
    expect(kit.transport.requests).toHaveLength(2);
    expect(kit.queue().failedCount()).toBe(1);
    expect(kit.queue().pendingCount()).toBe(0);

    // O usuário decide: reenviar leva o mesmo item de volta com a mesma chave.
    expect(await kit.queue().retry(bad)).toBe(true);
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(3));
    await kit.engine().whenIdle();
    expect(kit.transport.keys.at(-1)).toBe(bad);
    expect(await listOf(kit.db)).toEqual([]);
  });

  describe('what must never delete the queue', () => {
    it('network error, 401 and a real logout leave every item in place', async () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: 'entrar', component: Blank }]),
          { provide: AuthApi, useValue: { logout: vi.fn().mockResolvedValue(undefined) } },
        ],
      });
      const kit = setupQueue();
      const session = TestBed.inject(SessionState);
      kit.transport.fallback = ok(401);
      kit.pause();
      const ids = [
        await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } }),
        await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } }),
      ];
      kit.resume();
      session.setToken('token-de-teste', 600);
      const idsNow = async () => (await listOf(kit.db)).map((r) => r.id);

      kit.transport.script = [networkError()];
      await kit.engine().start();
      await kit.engine().drain({ force: true });
      expect(await idsNow()).toEqual(ids);

      await kit.engine().drain({ force: true }); // 401
      expect(await idsNow()).toEqual(ids);

      expect(await TestBed.inject(AuthService).logout()).toBe(true);
      expect(session.status()).toBe('anonymous');
      expect(await idsNow()).toEqual(ids);

      // Deslogado, nada é enviado e nada é apagado.
      const sent = kit.transport.requests.length;
      await kit.engine().drain({ force: true });
      expect(kit.transport.requests).toHaveLength(sent);
      expect(await idsNow()).toEqual(ids);
      expect(kit.queue().pendingCount()).toBe(2);
    });

    it('sends what waited for a session as soon as one exists, with the original keys', async () => {
      const kit = setupQueue();
      const session = TestBed.inject(SessionState);
      session.clear('anonymous');
      const id = await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.transport.requests).toHaveLength(0);

      session.setToken('t', 600);
      TestBed.tick();
      await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(1));
      await kit.engine().whenIdle();
      expect(kit.transport.keys).toEqual([id]);
      expect(await listOf(kit.db)).toEqual([]);
    });
  });

  it('does not touch the network while offline and sends when the connection returns, ignoring the backoff', async () => {
    setOnline(false);
    const kit = setupQueue();
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);
    expect(kit.transport.requests).toHaveLength(0);
    expect(kit.queue().pendingCount()).toBe(1);

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(1));
    await kit.engine().whenIdle();
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('the online event retries immediately even in the middle of a backoff', async () => {
    const kit = setupQueue();
    kit.transport.script = [networkError()];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);
    expect((await listOf(kit.db))[0].nextAttemptAt).toBeGreaterThan(kit.runtime.now());

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(2));
    await kit.engine().whenIdle();
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('syncNow tries right away without waiting for the backoff', async () => {
    const kit = setupQueue();
    kit.transport.script = [networkError()];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);

    await kit.queue().syncNow();
    expect(kit.transport.requests).toHaveLength(2);
    expect(await listOf(kit.db)).toEqual([]);
  });

  it('returning to the foreground triggers a forced pass; the 30 s timer respects the backoff', async () => {
    const kit = setupQueue();
    kit.transport.script = [networkError()];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);

    // O temporizador de 30 s só tenta depois do prazo do backoff (aqui 2 s): já passou, então envia.
    kit.runtime.advance(POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(2));
    await kit.engine().whenIdle();

    kit.transport.script = [networkError()];
    await kit.queue().enqueue(NEW_ITEM);
    await kit.engine().whenIdle();
    await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(3));
    await kit.engine().whenIdle();
    const before = kit.transport.requests.length;

    // voltar para a aba ignora a espera
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(kit.transport.requests.length).toBeGreaterThan(before));
    await kit.engine().whenIdle();
    expect(await listOf(kit.db)).toEqual([]);
  });

  describe('timers', () => {
    it('there is no timer without pending items', async () => {
      const kit = setupQueue();
      await settle(kit);
      expect(kit.runtime.activeTimers).toBe(0);

      await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.queue().pendingCount()).toBe(0);
      expect(kit.runtime.activeTimers).toBe(0);
    });

    it('while something is pending and the page is visible the 30 s timer and the retry wake exist, and they go away when the queue empties', async () => {
      const kit = setupQueue();
      kit.transport.script = [networkError()];
      await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.runtime.activeTimers).toBe(2); // temporizador de 30 s + acordar no prazo do backoff

      kit.runtime.advance(POLL_INTERVAL_MS);
      await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(2));
      await kit.engine().whenIdle();
      expect(await listOf(kit.db)).toEqual([]);
      expect(kit.runtime.activeTimers).toBe(0);
    });

    it('a hidden page keeps no timer, and failed items alone never keep one alive', async () => {
      const kit = setupQueue();
      kit.transport.script = [problem(422, 'validation-failed')];
      await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.queue().failedCount()).toBe(1);
      expect(kit.runtime.activeTimers).toBe(0);

      kit.transport.script = [networkError()];
      await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.runtime.activeTimers).toBe(2);
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(kit.runtime.activeTimers).toBe(0);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
  });

  describe('between tabs', () => {
    it('does not send while another tab holds the lock, and sends once it is released', async () => {
      const kit = setupQueue();
      const release = kit.locks.holdExternally('uniover-sync');
      await kit.queue().enqueue(NEW_ITEM);
      await settle(kit);
      expect(kit.transport.requests).toHaveLength(0);
      expect(kit.queue().pendingCount()).toBe(1);

      release();
      kit.runtime.advance(POLL_INTERVAL_MS);
      await vi.waitFor(() => expect(kit.transport.requests).toHaveLength(1));
      await kit.engine().whenIdle();
      expect(await listOf(kit.db)).toEqual([]);
    });

    it('two engines on the same database and lock never send at the same time', async () => {
      const kit = setupQueue();
      const gate = deferred();
      kit.transport.gate = gate.promise;
      await kit.queue().enqueue(NEW_ITEM);

      const other = runInInjectionContext(TestBed.inject(Injector), () => new SyncEngine());
      const first = kit.engine().start();
      await vi.waitFor(() => expect(kit.transport.inFlight).toBe(1));
      const second = other.start();
      await second; // não consegue o bloqueio: volta sem enviar
      expect(kit.transport.requests).toHaveLength(1);

      gate.open();
      await first;
      expect(kit.transport.maxInFlight).toBe(1);
      expect(await listOf(kit.db)).toEqual([]);
    });
  });

  it('puts back to pending whatever a closed tab left as sending, and sends it with the same key', async () => {
    const db = createTestDb();
    await db.outbox.add({
      id: '0199aaaa-0000-7000-8000-000000000001',
      method: 'POST',
      url: '/api/v1/test/items',
      body: { n: 1 },
      module: 'teste',
      createdAt: 1,
      attempts: 1,
      nextAttemptAt: 0,
      status: 'sending',
      lastError: null,
      revision: 0,
    });
    const kit = setupQueue(db);

    await kit.engine().start();
    await kit.engine().whenIdle();

    expect(kit.transport.keys).toEqual(['0199aaaa-0000-7000-8000-000000000001']);
    expect(await listOf(db)).toEqual([]);
  });

  it('hydrates the counters from the database on start (items survive a reload)', async () => {
    const db = createTestDb();
    const first = setupQueue(db);
    first.transport.script = [networkError()];
    await first.queue().enqueue(NEW_ITEM);
    await first.engine().start();
    expect(first.queue().pendingCount()).toBe(1);

    // "Recarregar": outro TestBed, mesmo banco.
    TestBed.resetTestingModule();
    const second = setupQueue(db);
    expect(second.queue().pendingCount()).toBe(0); // ainda não hidratou
    second.transport.gate = new Promise(() => undefined); // não termina: observa o estado hidratado
    void second.engine().start();
    await vi.waitFor(() => expect(second.queue().pendingCount()).toBe(1));
  });

  it('a transport that throws is treated as a network failure and the item stays', async () => {
    const kit = setupQueue();
    kit.transport.script = [() => Promise.reject(new Error('quebrou'))];
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);

    const [row] = await listOf(kit.db);
    expect(row).toMatchObject({ status: 'pending', lastError: 'network', attempts: 1 });
  });

  it('records when the last item was accepted', async () => {
    const kit = setupQueue();
    expect(kit.queue().lastSyncAt()).toBeNull();
    await kit.queue().enqueue(NEW_ITEM);
    await settle(kit);
    expect(kit.queue().lastSyncAt()).toBe(kit.runtime.now());
  });

  it('reports syncing while a send is in flight', async () => {
    const kit = setupQueue();
    const gate = deferred();
    kit.transport.gate = gate.promise;
    await kit.queue().enqueue(NEW_ITEM);
    const run = kit.engine().start();
    await vi.waitFor(() => expect(kit.queue().syncing()).toBe(true));
    gate.open();
    await run;
    await vi.waitFor(() => expect(kit.queue().syncing()).toBe(false));
  });

  it('exposes a transport port so other code (and tests) can replace the sender', () => {
    const kit = setupQueue();
    expect(kit.transport).toBeInstanceOf(FakeTransport);
  });
});
