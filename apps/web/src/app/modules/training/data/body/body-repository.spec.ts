import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../../core/session/session-state';
import { trendDelta, weightTrend } from '../../domain/body/weight-trend';
import { bodyEntryDto, setupBody } from './body-data-test-kit';
import { type LocalBodyEntry, toLocalBodyEntry } from './body-entry';
import type { BodyWriteResult } from './body-repository';

// O relógio falso do teste marca 09/10/2025: é o "hoje" do aparelho.
const TODAY = '2025-10-09';

/** Os campos acrescentados ao corpo seguem no envio como `null` quando não foram medidos (nunca ausentes nem zero). */
const NEW_FIELDS_EMPTY = {
  chestCm: null,
  abdomenCm: null,
  forearmCm: null,
  calfCm: null,
  armRightCm: null,
  armLeftCm: null,
  forearmRightCm: null,
  forearmLeftCm: null,
  thighRightCm: null,
  thighLeftCm: null,
  calfRightCm: null,
  calfLeftCm: null,
  chestSkinfoldMm: null,
  abdomenSkinfoldMm: null,
  thighSkinfoldMm: null,
} as const;

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

function saved(result: BodyWriteResult): LocalBodyEntry {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.entry;
}

const remote = (...args: Parameters<typeof bodyEntryDto>) =>
  toLocalBodyEntry(bodyEntryDto(...args));

describe('BodyRepository', () => {
  describe('saveEntry', () => {
    it('writes to the device first and queues exactly one PUT with the whole entry', async () => {
      const t = setupBody();

      const entry = saved(
        await t.repository.saveEntry({
          weightKg: 82.4,
          bodyFatPct: 16.9,
          fatMethod: 'navy',
          waistCm: 86,
          neckCm: 38,
          note: '  de manhã  ',
        }),
      );

      expect(entry).toMatchObject({
        measuredOn: TODAY,
        weightKg: 82.4,
        bodyFatPct: 16.9,
        fatMethod: 'navy',
        waistCm: 86,
        neckCm: 38,
        hipCm: null,
        note: 'de manhã',
        deletedAt: null,
      });
      expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      expect(await t.repository.get(entry.id)).toEqual(entry);
      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: `/api/v1/training/body/entries/${entry.id}`,
        module: 'training',
        status: 'pending',
      });
      expect(queued[0].body).toEqual({
        measuredOn: TODAY,
        weightKg: 82.4,
        bodyFatPct: 16.9,
        fatMethod: 'navy',
        waistCm: 86,
        neckCm: 38,
        hipCm: null,
        armCm: null,
        thighCm: null,
        ...NEW_FIELDS_EMPTY,
        note: 'de manhã',
        clientUpdatedAt: new Date(entry.clientUpdatedAt).toISOString(),
        deleted: false,
      });
    });

    it('stores the new measurements with their side and sends them in the same PUT', async () => {
      const t = setupBody();

      const entry = saved(
        await t.repository.saveEntry({
          chestCm: 98.5,
          armRightCm: 35,
          armLeftCm: 33.5,
          calfLeftCm: 38,
          chestSkinfoldMm: 9.5,
        }),
      );

      expect(entry).toMatchObject({
        chestCm: 98.5,
        armRightCm: 35,
        armLeftCm: 33.5,
        weightKg: null,
      });
      const [queued] = await t.outbox();
      expect(queued.body).toMatchObject({
        ...NEW_FIELDS_EMPTY,
        chestCm: 98.5,
        armRightCm: 35,
        armLeftCm: 33.5,
        calfLeftCm: 38,
        chestSkinfoldMm: 9.5,
      });
    });

    it('refuses new values outside the API limits and queues nothing', async () => {
      const t = setupBody();

      expect(await t.repository.saveEntry({ chestCm: 9.9 })).toMatchObject({ status: 'invalid' });
      expect(await t.repository.saveEntry({ armLeftCm: 250.1 })).toMatchObject({
        status: 'invalid',
      });
      expect(await t.repository.saveEntry({ thighSkinfoldMm: 0.9 })).toMatchObject({
        status: 'invalid',
      });
      expect(await t.repository.saveEntry({ abdomenSkinfoldMm: 100.1 })).toMatchObject({
        status: 'invalid',
      });
      expect(await t.outbox()).toHaveLength(0);
    });

    it('sends null for the new fields of a row saved before they existed', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80 }));
      // Linha antiga do banco local: não tem as chaves novas (o Dexie guarda só o que foi escrito).
      const legacy = { ...entry } as Record<string, unknown>;
      for (const key of Object.keys(NEW_FIELDS_EMPTY)) delete legacy[key];
      await t.trainingDb.bodyEntries.put(legacy as unknown as LocalBodyEntry);

      saved(await t.repository.saveEntry({ weightKg: 81 }, entry.id));

      const queued = await t.outbox();
      expect(queued[1].body).toMatchObject({ weightKg: 81, ...NEW_FIELDS_EMPTY });
    });

    it('takes the date the owner picked, and one value alone is enough', async () => {
      const t = setupBody();

      const entry = saved(await t.repository.saveEntry({ measuredOn: '2025-10-01', waistCm: 84 }));

      expect(entry).toMatchObject({ measuredOn: '2025-10-01', waistCm: 84, weightKg: null });
      expect(await t.outbox()).toHaveLength(1);
    });

    it('edits by id: replaces the entry as a whole, keeps the row and moves the clock forward', async () => {
      const t = setupBody();
      const first = saved(await t.repository.saveEntry({ weightKg: 82, waistCm: 86 }));

      const second = saved(await t.repository.saveEntry({ weightKg: 81.5 }, first.id));

      expect(await t.trainingDb.bodyEntries.count()).toBe(1);
      expect(second).toMatchObject({
        id: first.id,
        weightKg: 81.5,
        waistCm: null,
        measuredOn: TODAY,
      });
      expect(second.clientUpdatedAt).toBeGreaterThan(first.clientUpdatedAt);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued[1].url).toBe(queued[0].url);
      expect(queued[1].body).toMatchObject({ weightKg: 81.5, waistCm: null });
    });

    it('moves the clock forward by at least one even when the device clock is stuck', async () => {
      const t = setupBody();
      const a = saved(await t.repository.saveEntry({ weightKg: 80 }));
      const b = saved(await t.repository.saveEntry({ weightKg: 81 }, a.id));
      const c = saved(await t.repository.saveEntry({ weightKg: 82 }, a.id));

      expect(b.clientUpdatedAt).toBeGreaterThan(a.clientUpdatedAt);
      expect(c.clientUpdatedAt).toBeGreaterThan(b.clientUpdatedAt);
    });

    it('refuses what the API would refuse, and queues nothing', async () => {
      const t = setupBody();

      expect(await t.repository.saveEntry({})).toEqual({
        status: 'invalid',
        issues: [{ path: 'values', code: 'empty' }],
      });
      expect(await t.repository.saveEntry({ note: 'só anotação' })).toMatchObject({
        status: 'invalid',
      });
      expect(await t.repository.saveEntry({ weightKg: 19.9 })).toEqual({
        status: 'invalid',
        issues: [{ path: 'weightKg', code: 'value-range' }],
      });
      expect(await t.repository.saveEntry({ weightKg: 82.456 })).toMatchObject({
        status: 'invalid',
      });
      expect(await t.repository.saveEntry({ bodyFatPct: 15 })).toEqual({
        status: 'invalid',
        issues: [{ path: 'fatMethod', code: 'fat-method-required' }],
      });
      expect(await t.repository.saveEntry({ weightKg: 80, fatMethod: 'navy' })).toEqual({
        status: 'invalid',
        issues: [{ path: 'fatMethod', code: 'fat-method-without-fat' }],
      });
      expect(await t.repository.saveEntry({ weightKg: 80, measuredOn: '2025-10-11' })).toEqual({
        status: 'invalid',
        issues: [{ path: 'measuredOn', code: 'date-invalid' }],
      });
      expect(await t.repository.saveEntry({ weightKg: Number.NaN })).toMatchObject({
        status: 'invalid',
      });

      expect(await t.trainingDb.bodyEntries.count()).toBe(0);
      expect(await t.outbox()).toHaveLength(0);
    });

    it('accepts a date one day ahead of the device day, as the API does', async () => {
      const t = setupBody();

      expect(
        (await t.repository.saveEntry({ weightKg: 80, measuredOn: '2025-10-10' })).status,
      ).toBe('saved');
    });

    it('does not edit an entry that does not exist or was deleted', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80 }));
      saved(await t.repository.softDeleteEntry(entry.id));
      const queued = (await t.outbox()).length;

      expect(await t.repository.saveEntry({ weightKg: 81 }, entry.id)).toEqual({
        status: 'not-found',
      });
      expect(await t.repository.saveEntry({ weightKg: 81 }, 'nao-existe')).toEqual({
        status: 'not-found',
      });
      expect(await t.outbox()).toHaveLength(queued);
    });

    it('undoes the local write when the queue has no room, and leaves the previous entry as it was', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80 }));
      const before = await t.trainingDb.bodyEntries.get(entry.id);
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.saveEntry({ weightKg: 85 }, entry.id)).toEqual({
        status: 'storage-full',
      });
      expect(await t.repository.saveEntry({ weightKg: 70 })).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.bodyEntries.get(entry.id)).toEqual(before);
      expect(await t.trainingDb.bodyEntries.count()).toBe(1);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('does not depend on a login: a 401 or a logout leaves the entries and the queue alone', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80 }));

      TestBed.inject(SessionState).clear('anonymous');

      expect((await t.repository.get(entry.id))?.weightKg).toBe(80);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('bumps the revision on every local write', async () => {
      const t = setupBody();
      const before = t.repository.revision();

      await t.repository.saveEntry({ weightKg: 80 });

      expect(t.repository.revision()).toBeGreaterThan(before);
    });
  });

  describe('softDeleteEntry', () => {
    it('deletes by tombstone: the row stays, hidden and without any health value, and the PUT carries the tombstone', async () => {
      const t = setupBody();
      const entry = saved(
        await t.repository.saveEntry({
          weightKg: 82,
          bodyFatPct: 15,
          fatMethod: 'manual',
          note: 'segredo',
        }),
      );

      const removed = saved(await t.repository.softDeleteEntry(entry.id));

      expect(removed).toMatchObject({
        id: entry.id,
        weightKg: null,
        bodyFatPct: null,
        fatMethod: null,
        note: '',
        deletedAt: expect.any(Number),
      });
      expect(await t.repository.get(entry.id)).toBeUndefined();
      expect(await t.repository.entries()).toEqual([]);
      expect(await t.trainingDb.bodyEntries.count()).toBe(1);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued[1].url).toBe(queued[0].url);
      expect(queued[1].body).toMatchObject({
        measuredOn: TODAY,
        weightKg: null,
        bodyFatPct: null,
        fatMethod: null,
        note: null,
        deleted: true,
      });
    });

    it('has nothing to delete when there is no live entry, and queues nothing', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80 }));
      saved(await t.repository.softDeleteEntry(entry.id));
      const queued = (await t.outbox()).length;

      expect(await t.repository.softDeleteEntry(entry.id)).toEqual({ status: 'not-found' });
      expect(await t.repository.softDeleteEntry('nao-existe')).toEqual({ status: 'not-found' });

      expect(await t.outbox()).toHaveLength(queued);
    });

    it('restores the entry when the queue has no room for the deletion', async () => {
      const t = setupBody();
      const entry = saved(await t.repository.saveEntry({ weightKg: 80, note: 'x' }));
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.softDeleteEntry(entry.id)).toEqual({ status: 'storage-full' });

      expect(await t.repository.get(entry.id)).toEqual(entry);
    });
  });

  describe('entries', () => {
    it('lists the live entries of a period, oldest first, and the tombstone never shows', async () => {
      const t = setupBody();
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-05', weightKg: 80 }));
      saved(await t.repository.saveEntry({ measuredOn: '2025-09-20', weightKg: 81 }));
      const gone = saved(await t.repository.saveEntry({ measuredOn: '2025-10-01', weightKg: 99 }));
      saved(await t.repository.softDeleteEntry(gone.id));
      saved(await t.repository.saveEntry({ measuredOn: '2025-08-01', weightKg: 83 }));

      expect((await t.repository.entries()).map((row) => row.measuredOn)).toEqual([
        '2025-08-01',
        '2025-09-20',
        '2025-10-05',
      ]);
      expect(
        (await t.repository.entries({ from: '2025-09-01', to: '2025-10-05' })).map(
          (row) => row.measuredOn,
        ),
      ).toEqual(['2025-09-20', '2025-10-05']);
      expect(
        (await t.repository.entries({ from: '2025-10-01' })).map((row) => row.weightKg),
      ).toEqual([80]);
      expect(await t.repository.entries({ from: '2025-10-06', to: '2025-10-01' })).toEqual([]);
    });

    it('orders two entries of the same day by the order they were written', async () => {
      const t = setupBody();
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-05', weightKg: 80 }));
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-05', weightKg: 79 }));

      expect((await t.repository.entries()).map((row) => row.weightKg)).toEqual([80, 79]);
    });
  });

  describe('weight samples and trend', () => {
    it('feeds the trend with the weight of each entry, the last written one winning the day', async () => {
      const t = setupBody();
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-01', weightKg: 80 }));
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-02', weightKg: 82 }));
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-02', weightKg: 79 }));
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-03', waistCm: 84 }));

      const samples = await t.repository.weightSamples();
      const points = weightTrend(samples);

      expect(samples).toHaveLength(4);
      expect(points.map((p) => [p.date, p.weightKg])).toEqual([
        ['2025-10-01', 80],
        ['2025-10-02', 79],
      ]);
      expect(trendDelta(samples, 14)).toMatchObject({ fullWindow: false, spanDays: 1 });
    });
  });

  describe('latestMeasurements', () => {
    it('gives the last measure of each type with its date, even from different entries', async () => {
      const t = setupBody();
      saved(
        await t.repository.saveEntry({
          measuredOn: '2025-10-01',
          weightKg: 83,
          waistCm: 88,
          neckCm: 38,
          armCm: 35,
        }),
      );
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-05', weightKg: 82.4 }));
      saved(
        await t.repository.saveEntry({
          measuredOn: '2025-10-03',
          bodyFatPct: 16.9,
          fatMethod: 'navy',
          waistCm: 86,
        }),
      );

      expect(await t.repository.latestMeasurements()).toEqual({
        weightKg: { value: 82.4, measuredOn: '2025-10-05' },
        bodyFatPct: { value: 16.9, measuredOn: '2025-10-03', fatMethod: 'navy' },
        waistCm: { value: 86, measuredOn: '2025-10-03' },
        neckCm: { value: 38, measuredOn: '2025-10-01' },
        armCm: { value: 35, measuredOn: '2025-10-01' },
      });
    });

    it('does not show a measure of a deleted entry, and has no key for what was never measured', async () => {
      const t = setupBody();
      saved(await t.repository.saveEntry({ measuredOn: '2025-10-01', weightKg: 83 }));
      const newest = saved(
        await t.repository.saveEntry({ measuredOn: '2025-10-05', weightKg: 80, hipCm: 99 }),
      );
      saved(await t.repository.softDeleteEntry(newest.id));

      expect(await t.repository.latestMeasurements()).toEqual({
        weightKg: { value: 83, measuredOn: '2025-10-01' },
      });
    });

    it('is empty when nothing was ever measured', async () => {
      const t = setupBody();

      expect(await t.repository.latestMeasurements()).toEqual({});
    });
  });

  describe('applyRemote', () => {
    it('brings in entries by id, tombstones included, with the numbers of the generated type as numbers', async () => {
      const t = setupBody();

      await t.repository.applyRemote([
        remote('a', { weightKg: '82.40', waistCm: 86, fatMethod: 'navy', bodyFatPct: '16.9' }),
        remote('b', { deleted: true, weightKg: 99, note: 'segredo' }),
      ]);

      expect(await t.repository.get('a')).toMatchObject({
        weightKg: 82.4,
        waistCm: 86,
        bodyFatPct: 16.9,
        fatMethod: 'navy',
      });
      expect(await t.repository.get('b')).toBeUndefined();
      expect(await t.trainingDb.bodyEntries.get('b')).toMatchObject({
        weightKg: null,
        note: '',
        deletedAt: expect.any(Number),
      });
    });

    it('lets the newer clientUpdatedAt win: the local edit survives an older remote one', async () => {
      const t = setupBody();
      const local = saved(await t.repository.saveEntry({ weightKg: 80 }));

      await t.repository.applyRemote([
        remote(local.id, { weightKg: 70, clientUpdatedAt: '2020-01-01T00:00:00Z' }),
      ]);

      expect((await t.repository.get(local.id))?.weightKg).toBe(80);
    });

    it('lets a newer remote edit or tombstone win', async () => {
      const t = setupBody();
      const a = saved(await t.repository.saveEntry({ weightKg: 80 }));
      const b = saved(await t.repository.saveEntry({ weightKg: 81 }));

      await t.repository.applyRemote([
        remote(a.id, { weightKg: 77, clientUpdatedAt: '2999-01-01T00:00:00Z' }),
        remote(b.id, { deleted: true, clientUpdatedAt: '2999-01-01T00:00:00Z' }),
      ]);

      expect((await t.repository.get(a.id))?.weightKg).toBe(77);
      expect(await t.repository.get(b.id)).toBeUndefined();
    });

    it('never deletes a local entry for not being in the pull: it may be a write still in the queue', async () => {
      const t = setupBody();
      const local = saved(await t.repository.saveEntry({ weightKg: 80 }));

      await t.repository.applyRemote([remote('outra', { weightKg: 70 })]);

      expect((await t.repository.get(local.id))?.weightKg).toBe(80);
      expect(await t.trainingDb.bodyEntries.count()).toBe(2);
    });

    it('ignores an empty page and a fat method this version does not know', async () => {
      const t = setupBody();

      await t.repository.applyRemote([]);
      await t.repository.applyRemote([remote('x', { bodyFatPct: 12, fatMethod: 'dobras' })]);

      expect(await t.trainingDb.bodyEntries.count()).toBe(1);
      expect((await t.repository.get('x'))?.fatMethod).toBeNull();
    });
  });
});

describe('toLocalBodyEntry', () => {
  it('turns every number into a number, the missing note into an empty text and the tombstone into empty values', () => {
    expect(
      toLocalBodyEntry(
        bodyEntryDto('a', { weightKg: '82.25', chestCm: '90', armRightCm: '33.5', note: null }),
      ),
    ).toMatchObject({
      weightKg: 82.25,
      chestCm: 90,
      armRightCm: 33.5,
      note: '',
      deletedAt: null,
    });
    expect(
      toLocalBodyEntry(bodyEntryDto('a', { deleted: true, weightKg: 80, chestCm: 90, note: 'x' })),
    ).toMatchObject({
      weightKg: null,
      chestCm: null,
      note: '',
      deletedAt: expect.any(Number),
    });
  });
});
