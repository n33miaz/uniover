import { TestBed } from '@angular/core/testing';
import { QueueStorageFullError } from './outbox-store';
import { NEW_ITEM, networkError, setupQueue } from './queue-test-kit';
import { isUuid } from './uuid-v7';

function stubStorage(persist: () => Promise<boolean>) {
  const spy = vi.fn(persist);
  Object.defineProperty(window.navigator, 'storage', {
    value: { persist: spy },
    configurable: true,
  });
  return spy;
}

describe('OfflineQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.navigator, 'storage');
  });

  it('resolves only after the item is stored, with a UUID v7 that becomes the idempotency key', async () => {
    const kit = setupQueue();
    kit.transport.gate = new Promise(() => undefined); // nada é enviado: a promessa é de "guardado"

    const id = await kit.queue().enqueue({ ...NEW_ITEM, body: { a: 1 } });

    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(await kit.db.outbox.get(id)).toMatchObject({
      id,
      method: 'POST',
      url: NEW_ITEM.url,
      body: { a: 1 },
      module: 'teste',
      attempts: 0,
      status: 'pending',
      lastError: null,
    });
    expect(kit.queue().pendingCount()).toBe(1);
  });

  it('never throws because the device is offline or the API is asleep', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const kit = setupQueue();

    await expect(kit.queue().enqueue(NEW_ITEM)).resolves.toBeTypeOf('string');
    await kit.engine().start();
    expect(kit.transport.requests).toHaveLength(0);

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    kit.transport.script = [networkError()];
    await kit.engine().whenIdle();
    await expect(kit.queue().enqueue(NEW_ITEM)).resolves.toBeTypeOf('string');
  });

  it('refuses requests that are not writes to the same-origin API', async () => {
    const kit = setupQueue();
    await expect(kit.queue().enqueue({ ...NEW_ITEM, method: 'GET' as never })).rejects.toThrow(
      TypeError,
    );
    await expect(
      kit.queue().enqueue({ ...NEW_ITEM, url: 'https://outro.exemplo/api/x' }),
    ).rejects.toThrow(TypeError);
    await expect(
      kit.queue().enqueue({ ...NEW_ITEM, url: '//outro.exemplo/api/x' }),
    ).rejects.toThrow(TypeError);
    await expect(kit.queue().enqueue({ ...NEW_ITEM, url: '/outro/caminho' })).rejects.toThrow(
      TypeError,
    );
    expect(await kit.db.outbox.count()).toBe(0);
  });

  describe('persistent storage', () => {
    it('asks for persistence once, on the first use, and remembers it in the database', async () => {
      const persist = stubStorage(() => Promise.resolve(true));
      const kit = setupQueue();
      kit.transport.gate = new Promise(() => undefined);

      await kit.queue().enqueue(NEW_ITEM);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      await kit.queue().enqueue(NEW_ITEM);
      await kit.queue().enqueue(NEW_ITEM);

      // "Recarregar": outro TestBed com o mesmo banco não pergunta de novo.
      TestBed.resetTestingModule();
      const reloaded = setupQueue(kit.db);
      reloaded.transport.gate = new Promise(() => undefined);
      await reloaded.queue().enqueue(NEW_ITEM);
      await reloaded.store().claimPersistRequest();
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('swallows an error from persist() and still stores the item', async () => {
      const persist = stubStorage(() => Promise.reject(new Error('negado')));
      const kit = setupQueue();
      kit.transport.gate = new Promise(() => undefined);

      await expect(kit.queue().enqueue(NEW_ITEM)).resolves.toBeTypeOf('string');
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      expect(await kit.db.outbox.count()).toBe(1);
    });

    it('works in a browser without the storage API', async () => {
      const kit = setupQueue();
      kit.transport.gate = new Promise(() => undefined);
      await expect(kit.queue().enqueue(NEW_ITEM)).resolves.toBeTypeOf('string');
    });

    it('rejects when the device is out of space, because nothing was stored', async () => {
      const kit = setupQueue();
      vi.spyOn(kit.db.outbox, 'add').mockRejectedValue(
        Object.assign(new Error('cheio'), { name: 'QuotaExceededError' }),
      );

      await expect(kit.queue().enqueue(NEW_ITEM)).rejects.toBeInstanceOf(QueueStorageFullError);
      expect(await kit.db.outbox.count()).toBe(0);
      expect(kit.queue().pendingCount()).toBe(0);
    });

    it('lets other storage errors through unchanged', async () => {
      const kit = setupQueue();
      vi.spyOn(kit.db.outbox, 'add').mockRejectedValue(new Error('outro erro'));
      await expect(kit.queue().enqueue(NEW_ITEM)).rejects.toThrow('outro erro');
    });
  });

  describe('managing items', () => {
    it('editing an item that was never sent keeps its id and place', async () => {
      const kit = setupQueue();
      kit.pause();
      const id = await kit.queue().enqueue({ ...NEW_ITEM, body: { v: 1 } });

      expect(await kit.queue().update(id, { v: 2 })).toBe(true);
      expect(await kit.db.outbox.get(id)).toMatchObject({ body: { v: 2 }, revision: 1 });
    });

    it('editing an item that was already attempted gives it a fresh key, in the same place', async () => {
      const kit = setupQueue();
      kit.transport.script = [networkError()];
      kit.pause();
      const first = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 1 } });
      const second = await kit.queue().enqueue({ ...NEW_ITEM, body: { n: 2 } });
      kit.resume();
      await kit.engine().drain({ force: true }); // a 1ª tentativa de `first` falha e para a passagem

      kit.transport.gate = new Promise(() => undefined); // daqui em diante nada mais é enviado
      expect(await kit.queue().update(first, { n: 10 })).toBe(true);
      const items = await kit.queue().items();
      expect(items.map((i) => i.body)).toEqual([{ n: 10 }, { n: 2 }]);
      expect(items[0].id).not.toBe(first);
      expect(items[1].id).toBe(second);
      expect(await kit.db.outbox.get(first)).toBeUndefined();
    });

    it('discards only what the user asks to discard', async () => {
      const kit = setupQueue();
      kit.pause();
      const keep = await kit.queue().enqueue({ ...NEW_ITEM, body: 'fica' });
      const drop = await kit.queue().enqueue({ ...NEW_ITEM, body: 'sai' });

      expect(await kit.queue().discard(drop)).toBe(true);
      expect(await kit.queue().discard('nao-existe')).toBe(false);
      expect((await kit.queue().items()).map((i) => i.id)).toEqual([keep]);
      expect(kit.queue().pendingCount()).toBe(1);
    });

    it('retry only applies to failed items', async () => {
      const kit = setupQueue();
      kit.pause();
      const id = await kit.queue().enqueue(NEW_ITEM);
      expect(await kit.queue().retry(id)).toBe(false);
    });

    it('keeps the creation order even inside one millisecond or when the clock steps back', async () => {
      const kit = setupQueue();
      kit.pause();
      const ids = [
        await kit.queue().enqueue({ ...NEW_ITEM, body: 1 }),
        await kit.queue().enqueue({ ...NEW_ITEM, body: 2 }),
      ];
      kit.runtime.time -= 60_000; // relógio que recuou
      ids.push(await kit.queue().enqueue({ ...NEW_ITEM, body: 3 }));

      const items = await kit.queue().items();
      expect(items.map((i) => i.id)).toEqual(ids);
      expect(items.map((i) => i.createdAt)).toEqual(
        [...items.map((i) => i.createdAt)].sort((a, b) => a - b),
      );
      expect(new Set(items.map((i) => i.createdAt)).size).toBe(3);
    });

    it('lists the items oldest first', async () => {
      const kit = setupQueue();
      kit.pause();
      const a = await kit.queue().enqueue({ ...NEW_ITEM, body: 'a' });
      kit.runtime.advance(1_000);
      const b = await kit.queue().enqueue({ ...NEW_ITEM, body: 'b' });
      expect((await kit.queue().items()).map((i) => i.id)).toEqual([a, b]);
    });
  });
});
