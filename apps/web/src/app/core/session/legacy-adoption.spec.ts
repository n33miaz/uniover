import Dexie from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { OfflineDb, OutboxItem } from '../offline-queue/offline-db';
import { AdoptionOutcome, adoptLegacyDatabase, adoptWhenDue } from './legacy-adoption';

const LEGACY = 'uniover-offline';

function item(id: string, overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id,
    method: 'PUT',
    url: `/api/v1/training/sessions/${id}`,
    body: { id },
    module: 'training',
    createdAt: 1,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pending',
    lastError: null,
    revision: 0,
    ...overrides,
  };
}

describe('adoptLegacyDatabase', () => {
  let idb: IDBFactory;
  const options = () => ({ indexedDB: idb, IDBKeyRange: FakeIDBKeyRange });
  const openLegacy = (name: string) => new Dexie(name, options());
  const accountDb = (accountId: string) => new OfflineDb(`${LEGACY}-${accountId}`, options());

  /** O banco do tempo em que havia um só por aparelho, com itens pendentes, em voo e recusados e as marcas do `meta`. */
  async function seedLegacy(): Promise<void> {
    const legacy = new OfflineDb(LEGACY, options());
    await legacy.outbox.bulkAdd([
      item('a-pendente', { createdAt: 1 }),
      item('b-em-voo', { createdAt: 2, status: 'sending', attempts: 1 }),
      item('c-recusado', {
        createdAt: 3,
        status: 'failed',
        lastError: 'http-422:validation-failed',
      }),
    ]);
    await legacy.meta.bulkAdd([
      { key: 'lastSyncAt', value: 1_760_000_000_000 },
      { key: 'persistRequested', value: true },
    ]);
    legacy.close();
  }

  async function adopt(accountId: string, target = accountDb(accountId)): Promise<AdoptionOutcome> {
    return adoptLegacyDatabase({
      legacyName: LEGACY,
      accountId,
      target,
      tables: ['outbox', 'meta'],
      openLegacy,
    });
  }

  const ids = async (db: OfflineDb) =>
    (await db.outbox.orderBy('createdAt').toArray()).map((r) => r.id);

  beforeEach(() => {
    idb = new FakeIDBFactory();
  });

  it('copies every row of every table into the account database, checks them and marks the old one as adopted', async () => {
    await seedLegacy();
    const target = accountDb('conta-a');

    expect(await adopt('conta-a', target)).toBe('adopted');

    expect(await ids(target)).toEqual(['a-pendente', 'b-em-voo', 'c-recusado']);
    // Cada linha chega como estava (status, tentativas e erro incluídos), para o motor tratar como sempre.
    expect(await target.outbox.get('b-em-voo')).toMatchObject({ status: 'sending', attempts: 1 });
    expect(await target.outbox.get('c-recusado')).toMatchObject({
      status: 'failed',
      lastError: 'http-422:validation-failed',
    });
    expect((await target.meta.toArray()).map((row) => row.key).sort()).toEqual([
      'lastSyncAt',
      'persistRequested',
    ]);

    // O antigo não é apagado (é a cópia de segurança) e fica marcado como adotado por esta conta.
    const legacy = new OfflineDb(LEGACY, options());
    expect(await ids(legacy)).toEqual(['a-pendente', 'b-em-voo', 'c-recusado']);
    expect((await legacy.meta.get('adoption:claimedBy'))?.value).toBe('conta-a');
    expect(typeof (await legacy.meta.get('adoption:doneAt'))?.value).toBe('number');
  });

  it('does nothing when there is no old database, and leaves none behind', async () => {
    const target = accountDb('conta-a');

    expect(await adopt('conta-a', target)).toBe('none');

    expect(await target.outbox.count()).toBe(0);
    expect((await idb.databases()).map((db) => db.name)).not.toContain(LEGACY);
  });

  it('is already done the second time (nothing is copied again)', async () => {
    await seedLegacy();
    const target = accountDb('conta-a');
    await adopt('conta-a', target);
    // Uma linha que a conta já enviou (e que a fila apagou) não volta do banco antigo.
    await target.outbox.delete('a-pendente');

    expect(await adopt('conta-a', target)).toBe('already');

    expect(await ids(target)).toEqual(['b-em-voo', 'c-recusado']);
  });

  it('gives a second account nothing: the old database is already taken, and it starts empty', async () => {
    await seedLegacy();
    await adopt('conta-a');
    const second = accountDb('conta-b');

    expect(await adopt('conta-b', second)).toBe('taken');

    expect(await second.outbox.count()).toBe(0);
    expect(await second.meta.count()).toBe(0);
  });

  describe('a run that is interrupted', () => {
    it('is retried without duplicating, and never overwrites what the account already changed', async () => {
      await seedLegacy();
      const target = accountDb('conta-a');
      // A primeira tentativa caiu no meio da cópia; entretanto a conta já gravou uma linha com o mesmo id.
      const bulkAdd = vi
        .spyOn(target.table('outbox'), 'bulkAdd')
        .mockRejectedValueOnce(new Error('caiu'));
      expect(await adopt('conta-a', target)).toBe('failed');
      bulkAdd.mockRestore();
      await target.outbox.put(item('a-pendente', { body: { id: 'a-pendente', editado: true } }));

      expect(await adopt('conta-a', target)).toBe('adopted');

      expect(await ids(target)).toEqual(['a-pendente', 'b-em-voo', 'c-recusado']);
      expect((await target.outbox.get('a-pendente'))?.body).toEqual({
        id: 'a-pendente',
        editado: true,
      });
    });

    it('does not let another account take the rest: the first one claimed the old database before copying', async () => {
      await seedLegacy();
      const first = accountDb('conta-a');
      vi.spyOn(first.table('outbox'), 'bulkAdd').mockRejectedValue(new Error('caiu'));
      expect(await adopt('conta-a', first)).toBe('failed');

      const second = accountDb('conta-b');
      expect(await adopt('conta-b', second)).toBe('taken');
      expect(await second.outbox.count()).toBe(0);

      vi.restoreAllMocks();
      expect(await adopt('conta-a', first)).toBe('adopted');
      expect(await ids(first)).toEqual(['a-pendente', 'b-em-voo', 'c-recusado']);
    });

    it('is not marked as adopted when the copy does not check out', async () => {
      await seedLegacy();
      const target = accountDb('conta-a');
      // O destino "aceita" a gravação mas não guarda uma linha: a conferência acusa e nada é marcado.
      vi.spyOn(target.table('outbox'), 'bulkAdd').mockImplementation((async (
        rows: OutboxItem[],
      ) => {
        await target.outbox.bulkPut(rows.filter((row) => row.id !== 'c-recusado'));
      }) as never);

      expect(await adopt('conta-a', target)).toBe('failed');

      const legacy = new OfflineDb(LEGACY, options());
      expect(await legacy.meta.get('adoption:doneAt')).toBeUndefined();
      expect((await legacy.meta.get('adoption:claimedBy'))?.value).toBe('conta-a');
    });
  });

  it('never rejects: a database that cannot be opened is a failure to retry, not an error for the app', async () => {
    const outcome = await adoptLegacyDatabase({
      legacyName: LEGACY,
      accountId: 'conta-a',
      target: accountDb('conta-a'),
      tables: ['outbox', 'meta'],
      openLegacy: () => {
        throw new Error('sem IndexedDB');
      },
    });

    expect(outcome).toBe('failed');
  });

  it('gives up waiting for another tab after ten seconds and can retry without losing the legacy data', async () => {
    await seedLegacy();
    const target = accountDb('conta-a');
    const request = vi.fn(
      (_name: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The lock request was aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('navigator', { locks: { request } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const pending = adopt('conta-a', target);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe('failed');
    expect(request).toHaveBeenCalledOnce();
    expect(await target.outbox.count()).toBe(0);

    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(await new OfflineDb(LEGACY, options()).meta.get('adoption:claimedBy')).toBeUndefined();
    expect(await adopt('conta-a', target)).toBe('adopted');
    expect(await ids(target)).toEqual(['a-pendente', 'b-em-voo', 'c-recusado']);
  });

  it('does not copy the marks of the adoption itself into the new database', async () => {
    await seedLegacy();
    const target = accountDb('conta-a');
    await adopt('conta-a', target);

    const keys = (await target.meta.toArray()).map((row) => row.key);
    expect(keys.some((key) => key.startsWith('adoption:'))).toBe(false);
  });

  describe('adopting only when it is due', () => {
    function scopeOf(owner: string | null) {
      const finished: string[] = [];
      return {
        finished,
        scope: {
          shouldAdopt: (name: string, accountId: string) =>
            owner === accountId && !finished.includes(name),
          adoptionFinished: (name: string) => void finished.push(name),
        },
      };
    }
    const due = (scope: ReturnType<typeof scopeOf>['scope'], accountId = 'conta-a') =>
      adoptWhenDue(scope, {
        legacyName: LEGACY,
        accountId,
        target: accountDb(accountId),
        tables: ['outbox', 'meta'],
        openLegacy,
      });

    it('has nothing to wait for when the account is not the owner, or when it already finished', () => {
      expect(due(scopeOf('conta-b').scope)).toBeNull();
      const finished = scopeOf('conta-a');
      finished.finished.push(LEGACY);
      expect(due(finished.scope)).toBeNull();
    });

    it('notes that it finished, so the next start does not even look at the old database', async () => {
      await seedLegacy();
      const { scope, finished } = scopeOf('conta-a');

      expect(await due(scope)).toBe('adopted');

      expect(finished).toEqual([LEGACY]);
    });

    it('also notes it when there was no old database at all', async () => {
      const { scope, finished } = scopeOf('conta-a');

      expect(await due(scope)).toBe('none');

      expect(finished).toEqual([LEGACY]);
    });

    it('does not note a failure: the next start tries again', async () => {
      const { scope, finished } = scopeOf('conta-a');

      const outcome = await adoptWhenDue(scope, {
        legacyName: LEGACY,
        accountId: 'conta-a',
        target: accountDb('conta-a'),
        tables: ['outbox', 'meta'],
        openLegacy: () => {
          throw new Error('sem IndexedDB');
        },
      });

      expect(outcome).toBe('failed');
      expect(finished).toEqual([]);
    });
  });
});
