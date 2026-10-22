import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { OfflineQueue } from './offline-queue';
import { QUEUE_BOUND_ACCOUNT, QueueAccountError } from './queue-account';
import { NEW_ITEM, TEST_ACCOUNT, deferred, networkError, setupQueue } from './queue-test-kit';

const setOnline = (value: boolean) => TestBed.inject(ConnectivityService).online.set(value);

/** Uma fachada da fila amarrada a uma conta, como a que o escopo do Treino entrega aos repositórios dele. */
function boundTo(accountId: string): OfflineQueue {
  return Injector.create({
    providers: [{ provide: QUEUE_BOUND_ACCOUNT, useValue: accountId }, OfflineQueue],
    parent: TestBed.inject(Injector),
  }).get(OfflineQueue);
}

describe('the queue of each account', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('two accounts on the same device', () => {
    it('A saves offline and leaves; B enters and sees nothing of A, and nothing leaves as B; A returns and its item goes with A', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      setOnline(false);
      const id = await kit.queue().enqueue(NEW_ITEM);
      await kit.engine().start();
      expect(kit.queue().pendingCount()).toBe(1);
      expect(kit.transport.requests).toHaveLength(0);

      // A sai: a fila dela fica no disco, e o aparelho não tem mais nenhuma aberta.
      kit.account.signInAs(null);
      expect(kit.scopes().sync()).toBeNull();
      await kit.scopes().retired();
      expect(await kit.dbOf('conta-a').outbox.count()).toBe(1);

      // B entra (o servidor está alcançável de novo): não vê nada de A, a fila dele é vazia e nada sai.
      kit.account.signInAs('conta-b');
      setOnline(true);
      await kit.queue().start();
      await kit.engine().whenIdle();
      expect(await kit.queue().items()).toEqual([]);
      expect(kit.queue().pendingCount()).toBe(0);
      expect(kit.queue().failedCount()).toBe(0);
      expect(kit.queue().lastSyncAt()).toBeNull();
      expect(kit.transport.requests).toHaveLength(0);
      expect(await kit.dbOf('conta-b').outbox.count()).toBe(0);

      // A volta: vê o que era dela e o item pendente sai com a sessão de A.
      kit.account.signInAs('conta-a');
      await kit.queue().start();
      await kit.engine().whenIdle();
      expect(kit.transport.keys).toEqual([id]);
      expect(kit.transport.sentAs).toEqual(['conta-a']);
      expect(await kit.dbOf('conta-a').outbox.count()).toBe(0);
      expect(await kit.dbOf('conta-b').outbox.count()).toBe(0);
    });

    it('A pending, B enters while offline and the network comes back: nothing of A leaves with the token of B', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      setOnline(false);
      await kit.queue().enqueue({ ...NEW_ITEM, body: { de: 'A' } });
      await kit.queue().enqueue({ ...NEW_ITEM, body: { de: 'A', n: 2 } });

      kit.account.signInAs('conta-b');
      await kit.queue().start();
      setOnline(true);
      window.dispatchEvent(new Event('online'));
      await kit.engine().whenIdle();
      await kit.scopes().retired();

      expect(kit.transport.requests).toHaveLength(0);
      expect(await kit.dbOf('conta-a').outbox.count()).toBe(2);
      expect((await kit.dbOf('conta-a').outbox.toArray()).map((row) => row.status)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('a session that is not the one of the queue never sends it, and the queue stays untouched until the right one returns', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      kit.account.sessionAccount.set('conta-b'); // o token em memória é de B (a conta de A ficou pela dica)
      const id = await kit.queue().enqueue(NEW_ITEM);
      await kit.engine().start();
      await kit.engine().drain({ force: true });
      expect(kit.transport.requests).toHaveLength(0);
      expect((await kit.dbOf('conta-a').outbox.get(id))?.status).toBe('pending');

      kit.account.sessionAccount.set('conta-a');
      await kit.engine().drain({ force: true });
      expect(kit.transport.keys).toEqual([id]);
      expect(kit.transport.sentAs).toEqual(['conta-a']);
    });

    it('a session that changes owner in the middle of a pass stops it before the next item', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      const first = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } });
      const second = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } });
      const gate = deferred();
      kit.transport.gate = gate.promise;

      const start = kit.engine().start();
      await vi.waitFor(() => expect(kit.transport.inFlight).toBe(1));
      // Enquanto o primeiro está em voo, outra pessoa passa a ser dona da sessão.
      kit.account.sessionAccount.set('conta-b');
      gate.open();
      await start;
      await kit.engine().whenIdle();

      expect(kit.transport.keys).toEqual([first]);
      expect(kit.transport.sentAs).toEqual(['conta-a']);
      expect((await kit.dbOf('conta-a').outbox.toArray()).map((row) => row.id)).toEqual([second]);
    });

    it('a session that changes owner while the item is being marked as sending gives it back untouched, without counting an attempt', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      kit.account.sessionAccount.set('conta-b'); // por enquanto a sessão não é de A: nada sai
      const id = await kit.queue().enqueue(NEW_ITEM);
      await kit.engine().start();
      const store = kit.store();
      const marking = store.markSending.bind(store);
      vi.spyOn(store, 'markSending').mockImplementation(async (itemId, revision) => {
        const marked = await marking(itemId, revision);
        kit.account.sessionAccount.set('conta-b'); // outra pessoa assumiu a sessão neste intervalo
        return marked;
      });
      kit.account.sessionAccount.set('conta-a');

      await kit.engine().drain({ force: true });

      expect(kit.transport.requests).toHaveLength(0);
      expect(await kit.dbOf('conta-a').outbox.get(id)).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });

    it('switching account in the middle of a send lets the item in flight finish in its own database, and sends nothing else', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      const first = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } });
      const second = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } });
      const gate = deferred();
      kit.transport.gate = gate.promise;
      const engineOfA = kit.engine();
      void engineOfA.start();
      await vi.waitFor(() => expect(kit.transport.inFlight).toBe(1));

      kit.account.signInAs('conta-b');
      const queueOfB = kit.scopes().sync();
      expect(queueOfB?.accountId).toBe('conta-b');
      gate.open();
      await kit.scopes().retired();

      expect(kit.transport.keys).toEqual([first]);
      expect(await kit.dbOf('conta-a').outbox.toArray()).toMatchObject([
        { id: second, status: 'pending' },
      ]);
      expect(await kit.dbOf('conta-b').outbox.count()).toBe(0);
      // O motor da conta que saiu não faz mais nada, nem a pedido.
      await engineOfA.drain({ force: true });
      expect(kit.transport.requests).toHaveLength(1);
    });

    it('an engine that is put out of the scene before it finished starting ends quietly, instead of failing on a database about to close', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      const queueOfA = kit.scopes().sync()!;
      vi.spyOn(queueOfA.store, 'refresh').mockImplementation(async () => {
        kit.account.signInAs('conta-b');
        kit.scopes().sync(); // a conta sai de cena no meio da partida
        throw new Error('DatabaseClosedError');
      });

      await expect(queueOfA.engine.start()).resolves.toBeUndefined();
      await kit.scopes().retired();
    });

    it('but a start that fails with its account still in the scene is a real failure', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      const queueOfA = kit.scopes().sync()!;
      vi.spyOn(queueOfA.store, 'refresh').mockRejectedValue(new Error('de verdade'));

      await expect(queueOfA.engine.start()).rejects.toThrow('de verdade');
    });

    it('the signals and the engine of the account that left are gone: the new account starts from zero', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      setOnline(false);
      await kit.queue().enqueue(NEW_ITEM);
      kit.transport.script = [networkError()];
      expect(kit.queue().pendingCount()).toBe(1);
      const queueOfA = kit.scopes().sync()!;

      kit.account.signInAs('conta-b');
      kit.scopes().sync();

      expect(kit.queue().pendingCount()).toBe(0);
      expect(kit.scopes().active()?.engine).not.toBe(queueOfA.engine);
      expect(kit.scopes().active()?.store).not.toBe(queueOfA.store);
      await kit.scopes().retired();
      expect(kit.runtime.activeTimers).toBe(0);
    });
  });

  describe('without a known account', () => {
    it('opens no database and refuses to store anything: no data in a database without an owner', async () => {
      const kit = setupQueue();
      kit.account.signInAs(null);

      expect(kit.scopes().sync()).toBeNull();
      await expect(kit.queue().enqueue(NEW_ITEM)).rejects.toBeInstanceOf(QueueAccountError);
      expect(await kit.queue().items()).toEqual([]);
      expect(await kit.queue().discard('x')).toBe(false);
      expect(await kit.queue().retry('x')).toBe(false);
      expect(await kit.queue().update('x', {})).toBe(false);
      await expect(kit.queue().start()).resolves.toBeUndefined();
      await expect(kit.queue().syncNow()).resolves.toBeUndefined();
      expect(kit.queue().pendingCount()).toBe(0);
      expect(kit.queue().syncing()).toBe(false);
      // Nenhum banco foi criado: nem o de uma conta, nem um "sem dono".
      expect((await kit.dbOptions.indexedDB.databases()).map((db) => db.name)).toEqual([]);
      expect(kit.transport.requests).toHaveLength(0);
    });

    it('opens the queue as soon as the account is known (the hint on a start without network)', async () => {
      const kit = setupQueue();
      kit.account.signInAs(null);
      expect(kit.scopes().sync()).toBeNull();

      kit.account.id.set('conta-a');
      expect(kit.scopes().sync()?.accountId).toBe('conta-a');
    });
  });

  describe('a queue tied to an account', () => {
    it('stores in the queue of that account', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      setOnline(false);

      const id = await boundTo('conta-a').enqueue(NEW_ITEM);

      expect(await kit.dbOf('conta-a').outbox.get(id)).toBeDefined();
    });

    it('refuses a write that arrives after the device changed account, instead of putting it in the other queue', async () => {
      const kit = setupQueue();
      kit.account.signInAs('conta-a');
      const tied = boundTo('conta-a');
      await tied.enqueue(NEW_ITEM);

      kit.account.signInAs('conta-b');
      await expect(tied.enqueue(NEW_ITEM)).rejects.toBeInstanceOf(QueueAccountError);

      expect(await kit.dbOf('conta-b').outbox.count()).toBe(0);
      expect(tied.pendingCount()).toBe(0);
      expect(await tied.items()).toEqual([]);
      expect(tied.accountId).toBe('conta-a');
    });

    it('is the queue of the account in use when not tied to any', async () => {
      const kit = setupQueue();
      expect(kit.queue().accountId).toBe(TEST_ACCOUNT);
      kit.account.signInAs('conta-b');
      expect(kit.queue().accountId).toBe('conta-b');
    });
  });

  describe('the old database, from before there was one per account', () => {
    async function seedLegacy(kit: ReturnType<typeof setupQueue>) {
      const legacy = kit.legacyDb();
      await legacy.outbox.bulkAdd([
        {
          id: 'a-pendente',
          method: 'POST',
          url: '/api/v1/test/items',
          body: { n: 1 },
          module: 'teste',
          createdAt: 1,
          attempts: 0,
          nextAttemptAt: 0,
          status: 'pending',
          lastError: null,
          revision: 0,
        },
        {
          id: 'c-recusado',
          method: 'POST',
          url: '/api/v1/test/items',
          body: { n: 2 },
          module: 'teste',
          createdAt: 2,
          attempts: 1,
          nextAttemptAt: 0,
          status: 'failed',
          lastError: 'http-422:validation-failed',
          revision: 0,
        },
      ]);
      legacy.close();
    }

    it('adopts when /me confirms the owner after the queue opened', async () => {
      const kit = setupQueue();
      await seedLegacy(kit);
      setOnline(false);
      kit.account.legacyDecided.set(false);
      kit.account.signInAs('conta-a');
      const before = kit.scopes().sync()!;
      await before.engine.start();
      expect(await before.db.outbox.count()).toBe(0);

      kit.account.legacyOwner = 'conta-a';
      kit.account.legacyDecided.set(true);
      TestBed.tick();
      const after = kit.scopes().sync()!;
      expect(after).not.toBe(before);
      await after.ready;
      expect((await after.db.outbox.toArray()).map((row) => row.id).sort()).toEqual([
        'a-pendente',
        'c-recusado',
      ]);
      await kit.scopes().retired();
    });

    it('is adopted by the first account, which then sends the pending one once and keeps the refused one visible', async () => {
      const kit = setupQueue();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';
      kit.account.signInAs('conta-a');

      await kit.queue().start();
      await kit.engine().whenIdle();

      expect(kit.transport.keys).toEqual(['a-pendente']);
      expect(kit.transport.sentAs).toEqual(['conta-a']);
      expect((await kit.queue().items()).map((row) => [row.id, row.status])).toEqual([
        ['c-recusado', 'failed'],
      ]);
      expect(kit.queue().failedCount()).toBe(1);
    });

    it('is not seen by a second account, which starts empty and sends nothing', async () => {
      const kit = setupQueue();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';
      kit.account.signInAs('conta-a');
      await kit.queue().start();
      await kit.engine().whenIdle();

      kit.account.signInAs('conta-b');
      await kit.queue().start();
      await kit.engine().whenIdle();

      expect(await kit.queue().items()).toEqual([]);
      expect(kit.queue().pendingCount()).toBe(0);
      expect(kit.transport.requests).toHaveLength(1); // só o de A, de antes
    });

    it('waits for the adoption before storing or sending anything', async () => {
      const kit = setupQueue();
      await seedLegacy(kit);
      kit.account.legacyOwner = 'conta-a';
      kit.account.signInAs('conta-a');

      const id = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 3 } });

      // Quando o `enqueue` volta, o que veio do banco antigo já está lá (a cópia terminou antes de guardar o novo).
      expect((await kit.dbOf('conta-a').outbox.toArray()).map((row) => row.id).sort()).toEqual(
        ['a-pendente', 'c-recusado', id].sort(),
      );
    });
  });

  it('puts the queue of the account in use out of the scene when the application goes away, so no listener outlives it', () => {
    const kit = setupQueue();
    kit.account.signInAs('conta-a');
    const queue = kit.scopes().sync()!;
    expect((queue.injector as unknown as { destroyed: boolean }).destroyed).toBe(false);

    TestBed.resetTestingModule();

    expect((queue.injector as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('follows the account on its own once started: the queue of whoever enters is opened and started', async () => {
    const kit = setupQueue();
    kit.account.signInAs('conta-a');
    const scopes = kit.scopes();
    scopes.follow();
    expect(scopes.active()?.accountId).toBe('conta-a');

    kit.account.signInAs('conta-b');
    TestBed.tick();

    expect(scopes.active()?.accountId).toBe('conta-b');
    await scopes.retired();
  });
});
