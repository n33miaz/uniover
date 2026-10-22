import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import {
  NEW_ITEM,
  TEST_ACCOUNT,
  deferred,
  networkError,
  setupQueue,
} from '../../../../core/offline-queue/queue-test-kit';
import { TRAINING_DB } from '../training-db';
import { CURSOR_REWIND_MS } from './cursor';
import { PullApi } from './pull-api';
import { PullPage, ResourceSync, TRAINING_RESOURCE_SYNCS } from './resource-sync';
import { TrainingSync } from './training-sync';
import { FakePullApi, createTrainingTestDb } from './training-test-kit';

const PATH = '/api/v1/training/things';

// Cursor no formato do servidor: base64url de "<ticks>|<uuid>".
const encode = (ticks: bigint) =>
  btoa(`${ticks}|f2d8a1f0-1c5e-4a77-9a8e-3b6f7c1d2e90`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const ticksOf = (cursor: string | null) => {
  const base64 = (cursor ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return BigInt(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')).split('|')[0]);
};

const page = (items: string[], nextCursor: string | null): PullPage<string> => ({
  items,
  nextCursor,
});

function setup() {
  const kit = setupQueue();
  const db = createTrainingTestDb();
  const pull = new FakePullApi();
  const merged: string[][] = [];
  const resource: ResourceSync<string> = {
    resource: 'things',
    path: PATH,
    pageSize: 2,
    merge: (items) => {
      merged.push([...items]);
      return Promise.resolve();
    },
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: TRAINING_DB, useValue: db },
      { provide: PullApi, useValue: pull },
      { provide: TRAINING_RESOURCE_SYNCS, useValue: resource, multi: true },
      TrainingSync,
    ],
  });
  return { ...kit, db, pull, merged, resource, sync: () => TestBed.inject(TrainingSync) };
}

const setOnline = (value: boolean) => TestBed.inject(ConnectivityService).online.set(value);

describe('TrainingSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  describe('pulling', () => {
    it('follows nextCursor page by page until a short page, merging each page in order', async () => {
      const t = setup();
      t.pull.script = [page(['a', 'b'], 'c1'), page(['c', 'd'], 'c2'), page(['e'], 'c3')];

      await t.sync().start();

      expect(t.pull.calls).toEqual([
        { path: PATH, after: null, limit: 2, accountId: TEST_ACCOUNT },
        { path: PATH, after: 'c1', limit: 2, accountId: TEST_ACCOUNT },
        { path: PATH, after: 'c2', limit: 2, accountId: TEST_ACCOUNT },
      ]);
      expect(t.merged).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
      expect(await t.db.syncState.get('things')).toEqual({
        resource: 'things',
        cursor: 'c3',
        lastPullAt: t.runtime.now(),
      });
      expect(t.sync().lastPullAt()).toBe(t.runtime.now());
      expect(t.sync().pulling()).toBe(false);
      expect(t.sync().error()).toBeNull();
    });

    it('stops on a cursor that did not move, never looping on a server that repeats itself', async () => {
      const t = setup();
      t.pull.script = [page(['a', 'b'], 'c1'), page(['c', 'd'], 'c1')];

      await t.sync().start();

      expect(t.pull.calls).toHaveLength(2);
    });

    it('does not treat a null nextCursor as "more pages"', async () => {
      const t = setup();
      t.pull.script = [page(['a', 'b'], null)];

      await t.sync().start();

      expect(t.pull.calls).toHaveLength(1);
    });

    it('rewinds the stored cursor by 2 minutes on the first request only', async () => {
      const t = setup();
      const stored = encode(639_120_000_000_000_001n);
      await t.db.syncState.put({ resource: 'things', cursor: stored, lastPullAt: 1 });
      t.pull.script = [page(['a', 'b'], 'server-1'), page(['c'], 'server-2')];

      await t.sync().start();

      const [first, second] = t.pull.calls;
      expect(ticksOf(first.after)).toBe(
        639_120_000_000_000_001n - BigInt(CURSOR_REWIND_MS) * 10_000n,
      );
      expect(second.after).toBe('server-1');
      expect(await t.db.syncState.get('things')).toMatchObject({ cursor: 'server-2' });
    });

    it('keeps the stored cursor when the page is empty, so it never drifts backwards', async () => {
      const t = setup();
      const stored = encode(639_120_000_000_000_001n);
      await t.db.syncState.put({ resource: 'things', cursor: stored, lastPullAt: 1 });
      // O servidor devolve o cursor recebido (já recuado) numa página vazia.
      t.pull.script = [() => Promise.resolve(page([], 'echo'))];

      await t.sync().start();

      expect(await t.db.syncState.get('things')).toMatchObject({
        cursor: stored,
        lastPullAt: t.runtime.now(),
      });
    });

    it('pulls from the start when the stored cursor cannot be read', async () => {
      const t = setup();
      await t.db.syncState.put({ resource: 'things', cursor: '###', lastPullAt: 1 });

      await t.sync().start();

      expect(t.pull.calls[0].after).toBeNull();
    });

    it('keeps the progress of a pull that was interrupted halfway', async () => {
      const t = setup();
      t.pull.script = [page(['a', 'b'], 'c1'), new HttpErrorResponse({ status: 0 })];

      await t.sync().start();

      expect(await t.db.syncState.get('things')).toMatchObject({ cursor: 'c1', lastPullAt: null });
      expect(t.merged).toEqual([['a', 'b']]);
      expect(t.sync().error()).toBe('network');
    });

    it('restores the time of the last pull from the device on start', async () => {
      const t = setup();
      await t.db.syncState.put({ resource: 'things', cursor: null, lastPullAt: 777 });
      setOnline(false);

      await t.sync().start();

      expect(t.sync().lastPullAt()).toBe(777);
      expect(t.pull.calls).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('turns a network failure into a signal, not an exception, and keeps the previous time', async () => {
      const t = setup();
      await t.db.syncState.put({ resource: 'things', cursor: null, lastPullAt: 777 });
      t.pull.script = [new HttpErrorResponse({ status: 0 })];

      await expect(t.sync().start()).resolves.toBeUndefined();

      expect(t.sync().error()).toBe('network');
      expect(t.sync().lastPullAt()).toBe(777);
      expect(t.sync().pulling()).toBe(false);
    });

    it('tells a sleeping or busy server apart and clears the error on the next success', async () => {
      const t = setup();
      t.pull.script = [new HttpErrorResponse({ status: 503 })];
      await t.sync().start();
      expect(t.sync().error()).toBe('server');

      t.pull.script = [new HttpErrorResponse({ status: 429 })];
      await t.sync().pullNow();
      expect(t.sync().error()).toBe('server');

      t.pull.script = [new HttpErrorResponse({ status: 400 })];
      await t.sync().pullNow();
      expect(t.sync().error()).toBe('unexpected');

      t.pull.script = [page(['a'], 'c1')];
      await t.sync().pullNow();
      expect(t.sync().error()).toBeNull();
      expect(t.sync().lastPullAt()).toBe(t.runtime.now());
    });

    it('turns a merge failure into a signal too, without advancing the cursor', async () => {
      const t = setup();
      t.pull.script = [page(['a'], 'c1')];
      vi.spyOn(t.resource, 'merge').mockRejectedValue(new Error('disco cheio'));

      await expect(t.sync().start()).resolves.toBeUndefined();

      expect(t.sync().error()).toBe('unexpected');
      expect(await t.db.syncState.get('things')).toBeUndefined();
      expect(t.sync().pulling()).toBe(false);
    });

    it('does not throw when the device storage fails while starting, and tries again on the next start', async () => {
      const t = setup();
      const get = vi
        .spyOn(t.db.syncState, 'get')
        .mockRejectedValueOnce(new Error('banco indisponível'));

      await expect(t.sync().start()).resolves.toBeUndefined();
      expect(t.sync().error()).toBe('unexpected');
      expect(t.pull.calls).toHaveLength(0);

      get.mockRestore();
      await t.sync().start();
      expect(t.pull.calls).toHaveLength(1);
      expect(t.sync().error()).toBeNull();
    });
  });

  describe('when it pulls', () => {
    it('does nothing before start() and runs the first pass on start()', async () => {
      const t = setup();
      t.sync();
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
      expect(t.pull.calls).toHaveLength(0);

      await t.sync().start();
      expect(t.pull.calls).toHaveLength(1);
    });

    it('start() is idempotent', async () => {
      const t = setup();
      await Promise.all([t.sync().start(), t.sync().start()]);
      await t.sync().start();
      expect(t.pull.calls).toHaveLength(1);
    });

    it('does not pull while the write queue has pending items', async () => {
      const t = setup();
      t.pause();
      await t.queue().enqueue(NEW_ITEM);
      expect(t.queue().pendingCount()).toBe(1);

      await t.sync().start();
      await t.sync().pullNow();
      window.dispatchEvent(new Event('online'));

      expect(t.pull.calls).toHaveLength(0);
      expect(t.sync().pulling()).toBe(false);
      expect(t.sync().error()).toBeNull();
    });

    it('waits for the queue to be loaded from the device before the first check', async () => {
      // Um item que ficou de uma sessão anterior: `pendingCount` só mostra 1 depois de a fila ser hidratada.
      const first = setupQueue();
      first.pause();
      await first.queue().enqueue(NEW_ITEM);
      TestBed.resetTestingModule();

      const kit = setupQueue(first.db);
      const pull = new FakePullApi();
      TestBed.configureTestingModule({
        providers: [
          { provide: TRAINING_DB, useValue: createTrainingTestDb() },
          { provide: PullApi, useValue: pull },
          {
            provide: TRAINING_RESOURCE_SYNCS,
            multi: true,
            useValue: { resource: 'things', path: PATH, merge: () => Promise.resolve() },
          },
          TrainingSync,
        ],
      });
      kit.pause();
      expect(kit.queue().pendingCount()).toBe(0); // ainda não hidratada

      await TestBed.inject(TrainingSync).start();

      expect(kit.queue().pendingCount()).toBe(1);
      expect(pull.calls).toHaveLength(0);
    });

    it('pulls when a send finishes and the queue becomes empty', async () => {
      const t = setup();
      t.pause();
      await t.queue().enqueue(NEW_ITEM);
      await t.sync().start();
      expect(t.pull.calls).toHaveLength(0);

      t.resume();
      await t.queue().syncNow();
      expect(t.queue().pendingCount()).toBe(0);

      await vi.waitFor(() => {
        TestBed.tick();
        expect(t.pull.calls).toHaveLength(1);
      });
    });

    it('does not pull offline, without error, and pulls when the connection returns', async () => {
      const t = setup();
      setOnline(false);

      await t.sync().start();
      expect(t.pull.calls).toHaveLength(0);
      expect(t.sync().error()).toBeNull();

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(t.pull.calls).toHaveLength(1));
    });

    it('pulls when the user comes back to the tab, and only then', async () => {
      const t = setup();
      await t.sync().start();
      expect(t.pull.calls).toHaveLength(1);

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(t.pull.calls).toHaveLength(1);

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(t.pull.calls).toHaveLength(2));
    });

    it('the manual button sends what is queued and then pulls', async () => {
      const t = setup();
      await t.sync().start();
      t.pause();
      await t.queue().enqueue(NEW_ITEM);
      t.resume();
      const before = t.pull.calls.length;

      await t.sync().pullNow();

      expect(t.transport.requests).toHaveLength(1);
      expect(t.queue().pendingCount()).toBe(0);
      expect(t.pull.calls.length).toBeGreaterThan(before);
    });

    it('runs one pass at a time and folds the requests that arrive meanwhile into one extra pass', async () => {
      const t = setup();
      const gate = deferred();
      t.pull.gate = gate.promise;

      const started = t.sync().start();
      await vi.waitFor(() => expect(t.pull.calls).toHaveLength(1));
      expect(t.sync().pulling()).toBe(true);

      // Três pedidos no meio da passada.
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
      expect(t.pull.maxInFlight).toBe(1);

      gate.open();
      await started;
      await vi.waitFor(() => expect(t.sync().pulling()).toBe(false));
      await vi.waitFor(() => expect(t.pull.calls).toHaveLength(2));
      expect(t.pull.maxInFlight).toBe(1);
    });

    it('never starts a timer of its own', async () => {
      // O jsdom usa um intervalo de 16 ms para os quadros de animação: só interessam temporizadores de verdade.
      const intervalSpy = vi.spyOn(globalThis, 'setInterval');
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const t = setup();
      t.pull.script = [page(['a', 'b'], 'c1'), page(['c'], 'c2')];

      await t.sync().start();
      await t.sync().pullNow();

      const longDelays = [...intervalSpy.mock.calls, ...timeoutSpy.mock.calls]
        .map(([, delay]) => Number(delay ?? 0))
        .filter((delay) => delay >= 1000);
      expect(longDelays).toEqual([]);
      expect(t.runtime.activeTimers).toBe(0);
    });
  });

  it('does not pull after a send that failed, because the item is still pending', async () => {
    const t = setup();
    t.transport.script = [networkError()];
    t.pause();
    await t.queue().enqueue(NEW_ITEM);
    await t.sync().start();
    t.resume();
    await t.queue().syncNow();

    expect(t.queue().pendingCount()).toBe(1);
    expect(t.pull.calls).toHaveLength(0);
  });

  describe('only with the session of the account of the database', () => {
    it('does not pull with the token of another account (it would bring their data into this database), and pulls once the session is the right one', async () => {
      const t = setup();
      t.account.sessionAccount.set('outra-conta');
      t.pull.script = [page(['a'], 'c1')];

      await t.sync().start();

      expect(t.pull.calls).toHaveLength(0);
      expect(t.merged).toEqual([]);

      t.account.sessionAccount.set(TEST_ACCOUNT);
      TestBed.tick();
      await vi.waitFor(() => expect(t.merged).toEqual([['a']]));
    });

    it('does not pull while /me has not said whose the session is', async () => {
      const t = setup();
      t.account.sessionAccount.set(null);
      t.pull.script = [page(['a'], 'c1')];

      await t.sync().start();
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();

      expect(t.pull.calls).toHaveLength(0);
    });
  });
});
