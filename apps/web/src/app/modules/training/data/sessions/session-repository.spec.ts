import { Injector, runInInjectionContext } from '@angular/core';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { isUuid } from '../../../../core/offline-queue/uuid-v7';
import { networkError, ok, problem } from '../../../../core/offline-queue/queue-test-kit';
import { SessionState } from '../../../../core/session/session-state';
import { TestBed } from '@angular/core/testing';
import { createTrainingTestDb } from '../sync/training-test-kit';
import { exclusiveLocks, grantEverything, installLocks, removeLocks } from '../tab-lock-test-kit';
import { TRAINING_DB, TrainingDb } from '../training-db';
import { SessionRepository, type SetWriteResult } from './session-repository';
import { toLocalSession, toLocalSet } from './session';
import { seedExercises, sessionDto, setDto, setupSessions } from './session-data-test-kit';

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

function savedSet(result: SetWriteResult) {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.set;
}

async function started(t: ReturnType<typeof setupSessions>, routineId: string | null = null) {
  await seedExercises(t.trainingDb);
  const result = await t.repository.start(routineId);
  if (result.status !== 'started') throw new Error(`esperava "started", veio "${result.status}"`);
  return result.session;
}

describe('SessionRepository', () => {
  describe('device id', () => {
    it('is a UUID v7 generated once and kept', async () => {
      const t = setupSessions();

      const first = await t.repository.deviceId();
      const again = await t.repository.deviceId();

      expect(isUuid(first)).toBe(true);
      expect(first[14]).toBe('7');
      expect(again).toBe(first);
      expect((await t.trainingDb.meta.get('deviceId'))?.value).toBe(first);
    });

    it('is the same even when asked at the same time', async () => {
      const t = setupSessions();

      const ids = await Promise.all([1, 2, 3, 4, 5].map(() => t.repository.deviceId()));

      expect(new Set(ids).size).toBe(1);
    });
  });

  describe('start', () => {
    it('writes the session to the device first and queues one PUT with the device id', async () => {
      const t = setupSessions();
      const session = await started(t, 'rotina-a');

      expect(isUuid(session.id)).toBe(true);
      expect(session.id[14]).toBe('7');
      expect(session).toMatchObject({
        routineId: 'rotina-a',
        finishedAt: null,
        deviceId: await t.repository.deviceId(),
        deletedAt: null,
      });
      expect(await t.repository.activeSession()).toEqual(session);
      expect((await t.trainingDb.meta.get('activeSessionId'))?.value).toBe(session.id);

      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: `/api/v1/training/sessions/${session.id}`,
        module: 'training',
        status: 'pending',
        attempts: 0,
      });
      expect(queued[0].body).toMatchObject({
        routineId: 'rotina-a',
        finishedAt: null,
        note: null,
        feeling: null,
        deviceId: session.deviceId,
        deleted: false,
      });
    });

    it('does not open a second session on this device: it returns the active one and queues nothing', async () => {
      const t = setupSessions();
      const session = await started(t);

      const again = await t.repository.start();

      expect(again).toEqual({ status: 'already-active', session });
      expect(await t.outbox()).toHaveLength(1);
    });

    it('is blocked while another device has a session open, and queues nothing', async () => {
      const t = setupSessions();
      await t.trainingDb.sessions.put(
        toLocalSession(sessionDto('s-outro', { deviceId: 'tablet' })),
      );

      const result = await t.repository.start();

      expect(result).toMatchObject({ status: 'open-elsewhere', session: { id: 's-outro' } });
      expect(await t.repository.activeSession()).toBeUndefined();
      expect(await t.trainingDb.sessions.count()).toBe(1);
      expect(await t.outbox()).toEqual([]);
    });

    it('is not blocked by a session of another device that is finished or deleted', async () => {
      const t = setupSessions();
      await t.trainingDb.sessions.bulkPut([
        toLocalSession(
          sessionDto('encerrada', { deviceId: 'tablet', finishedAt: '2026-10-01T11:00:00Z' }),
        ),
        toLocalSession(sessionDto('apagada', { deviceId: 'tablet', deleted: true })),
      ]);

      expect((await t.repository.start()).status).toBe('started');
    });

    it('lists the sessions open elsewhere by age', async () => {
      const t = setupSessions();
      const now = t.runtime.now();
      await t.trainingDb.sessions.bulkPut([
        {
          ...toLocalSession(sessionDto('velha', { deviceId: 'tablet' })),
          startedAt: now - 13 * 3_600_000,
        },
        {
          ...toLocalSession(sessionDto('nova', { deviceId: 'tablet' })),
          startedAt: now - 3_600_000,
        },
      ]);
      await started(t).catch(() => undefined);

      const all = await t.repository.openSessionsElsewhere();
      const old = await t.repository.openSessionsElsewhere(12 * 3_600_000);

      expect(all.map((row) => row.id)).toEqual(['velha', 'nova']);
      expect(old.map((row) => row.id)).toEqual(['velha']);
    });

    it('undoes the local write when the queue has no space', async () => {
      const t = setupSessions();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.repository.start();

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.trainingDb.sessions.count()).toBe(0);
      expect(await t.trainingDb.meta.get('activeSessionId')).toBeUndefined();
      expect(await t.repository.activeSession()).toBeUndefined();
      expect(t.queue().pendingCount()).toBe(0);
    });
  });

  describe('start in two tabs at the same time', () => {
    afterEach(removeLocks);

    /** Uma segunda aba: outra conexão ao MESMO banco do aparelho e outro repositório (a fila é a mesma). */
    function openOtherTab(factory: IDBFactory, db: TrainingDb) {
      const otherDb = new TrainingDb(db.name, { indexedDB: factory, IDBKeyRange: FakeIDBKeyRange });
      const injector = Injector.create({
        providers: [{ provide: TRAINING_DB, useValue: otherDb }],
        parent: TestBed.inject(Injector),
      });
      return {
        repository: runInInjectionContext(injector, () => new SessionRepository()),
        db: otherDb,
      };
    }

    async function pressStartInBothTabs() {
      const factory = new FakeIDBFactory();
      const t = setupSessions(createTrainingTestDb(factory));
      const other = openOtherTab(factory, t.trainingDb);
      try {
        const results = await Promise.all([
          t.repository.start('rotina-a'),
          other.repository.start('rotina-a'),
        ]);
        return {
          t,
          results,
          alive: await t.trainingDb.sessions.toArray(),
          pointer: (await t.trainingDb.meta.get('activeSessionId'))?.value,
          queued: await t.outbox(),
        };
      } finally {
        other.db.close();
      }
    }

    function expectOneSessionAdoptedByTheOtherTab(
      done: Awaited<ReturnType<typeof pressStartInBothTabs>>,
    ) {
      const { results, alive, pointer, queued } = done;
      expect(results.map((result) => result.status).sort()).toEqual(['already-active', 'started']);
      const ids = results.map((result) => ('session' in result ? result.session.id : null));
      // A aba perdedora adota o treino da vencedora (o fluxo que a tela já trata), não abre outro.
      expect(new Set(ids).size).toBe(1);
      expect(alive).toHaveLength(1);
      expect(pointer).toBe(alive[0].id);
      expect(queued).toHaveLength(1);
    }

    it('opens a single session and the second tab adopts it', async () => {
      expectOneSessionAdoptedByTheOtherTab(await pressStartInBothTabs());
    });

    it('serializes the two starts through an exclusive lock named after the account database', async () => {
      const locks = exclusiveLocks();
      installLocks(locks.manager);

      const done = await pressStartInBothTabs();

      expectOneSessionAdoptedByTheOtherTab(done);
      expect(locks.requested).toEqual([
        `uniover-training-start:${done.t.trainingDb.name}`,
        `uniover-training-start:${done.t.trainingDb.name}`,
      ]);
    });

    it('still opens a single session when the lock lets both tabs in: the check is inside the write', async () => {
      installLocks(grantEverything());

      expectOneSessionAdoptedByTheOtherTab(await pressStartInBothTabs());
    });
  });

  describe('sets', () => {
    it('writes each set to the device with no network and queues the PUTs in the order of use', async () => {
      const t = setupSessions();
      const session = await started(t);
      t.runtime.advance(60_000);
      const first = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      t.runtime.advance(120_000);
      const second = savedSet(
        await t.repository.addSet({
          exerciseId: 'supino',
          weightKg: 82.5,
          reps: 6,
          rir: 2,
          rpe: 8.5,
          note: ' pesada ',
        }),
      );
      t.runtime.advance(120_000);
      const finished = await t.repository.finish({ feeling: 4, note: 'boa' });

      expect(finished.status).toBe('saved');
      expect([first.position, second.position]).toEqual([0, 1]);
      expect(second).toMatchObject({ setType: 'work', rir: 2, rpe: 8.5, note: 'pesada' });
      expect((await t.repository.setsOfSession(session.id)).map((row) => row.id)).toEqual([
        first.id,
        second.id,
      ]);

      // Sessão antes das séries, séries antes do fim: a ordem em que a fila guarda é a do uso.
      const queued = await t.outbox();
      expect(queued.map((item) => [item.method, item.url])).toEqual([
        ['PUT', `/api/v1/training/sessions/${session.id}`],
        ['PUT', `/api/v1/training/sessions/${session.id}/sets/${first.id}`],
        ['PUT', `/api/v1/training/sessions/${session.id}/sets/${second.id}`],
        ['PUT', `/api/v1/training/sessions/${session.id}`],
      ]);
      expect(queued[2].body).toMatchObject({
        exerciseId: 'supino',
        position: 1,
        setType: 'work',
        weightKg: 82.5,
        reps: 6,
        rir: 2,
        rpe: 8.5,
        note: 'pesada',
        deleted: false,
      });
      expect(queued[3].body).toMatchObject({ feeling: 4, note: 'boa', deleted: false });
      expect((queued[3].body as { finishedAt: string }).finishedAt).not.toBeNull();
      expect(new Set(queued.map((item) => item.id)).size).toBe(4);
      expect(t.transport.requests).toEqual([]);
    });

    it('sends everything in order once the network comes back, one request per item', async () => {
      const t = setupSessions();
      const session = await started(t);
      const first = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      await t.repository.finish();

      t.resume();
      await t.queue().syncNow();

      expect(t.transport.requests.map((request) => request.url)).toEqual([
        `/api/v1/training/sessions/${session.id}`,
        `/api/v1/training/sessions/${session.id}/sets/${first.id}`,
        `/api/v1/training/sessions/${session.id}`,
      ]);
      expect(await t.outbox()).toEqual([]);
    });

    it('reuses the same idempotency key on every attempt of the same item', async () => {
      const t = setupSessions();
      t.transport.script = [networkError()];
      await started(t);
      await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 });
      const queued = await t.outbox();

      t.resume();
      await t.queue().syncNow();
      await t.queue().syncNow();

      expect(t.transport.keys[0]).toBe(queued[0].id);
      expect(t.transport.keys[1]).toBe(queued[0].id);
      expect(new Set(t.transport.keys).size).toBe(2);
      expect(await t.outbox()).toEqual([]);
    });

    it('refuses a set without an open session, with an unknown exercise, or with the wrong shape', async () => {
      const t = setupSessions();
      await seedExercises(t.trainingDb);

      expect(await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 })).toEqual({
        status: 'no-active-session',
      });

      await t.repository.start();
      expect(await t.repository.addSet({ exerciseId: 'nao-existe', reps: 8 })).toEqual({
        status: 'exercise-not-found',
      });
      expect(await t.repository.addSet({ exerciseId: 'supino', reps: 8 })).toMatchObject({
        status: 'invalid',
        issues: [{ path: 'weightKg', code: 'weight-required' }],
      });
      expect(await t.repository.addSet({ exerciseId: 'prancha', reps: 8 })).toMatchObject({
        status: 'invalid',
        issues: [{ path: 'durationS', code: 'duration-required' }],
      });
      expect(await t.repository.addSet({ exerciseId: 'flexao', reps: 12 })).toMatchObject({
        status: 'saved',
      });
      expect(await t.repository.addSet({ exerciseId: 'prancha', durationS: 45 })).toMatchObject({
        status: 'saved',
      });
      expect(
        await t.repository.addSet({ exerciseId: 'supino', setType: 'warmup', reps: 10 }),
      ).toMatchObject({
        status: 'saved',
      });
      expect(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8, rpe: 7.25 }),
      ).toMatchObject({
        status: 'invalid',
        issues: [{ path: 'rpe', code: 'rpe-range' }],
      });
      // Só as quatro que valiam (a sessão + 3 séries) entraram na fila.
      expect(await t.outbox()).toHaveLength(4);
    });

    it('edits a set that was already sent as a second, newer PUT', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      t.resume();
      await t.queue().syncNow();
      t.pause();
      t.transport.requests.length = 0;

      t.runtime.advance(5_000);
      const edited = savedSet(await t.repository.editSet(set.id, { weightKg: 85, reps: 6 }));

      expect(edited.clientUpdatedAt).toBeGreaterThan(set.clientUpdatedAt);
      expect(edited).toMatchObject({
        weightKg: 85,
        reps: 6,
        position: set.position,
        completedAt: set.completedAt,
      });
      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0].url).toBe(`/api/v1/training/sessions/${session.id}/sets/${set.id}`);
      expect(queued[0].body).toMatchObject({ weightKg: 85, reps: 6, deleted: false });
      expect(
        new Date((queued[0].body as { clientUpdatedAt: string }).clientUpdatedAt).getTime(),
      ).toBe(edited.clientUpdatedAt);
    });

    it('edits even with the clock stuck, always with a newer clientUpdatedAt', async () => {
      const t = setupSessions();
      await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      const first = savedSet(await t.repository.editSet(set.id, { reps: 9 }));
      const second = savedSet(await t.repository.editSet(set.id, { reps: 10 }));

      expect(first.clientUpdatedAt).toBeGreaterThan(set.clientUpdatedAt);
      expect(second.clientUpdatedAt).toBeGreaterThan(first.clientUpdatedAt);
    });

    it('refuses an invalid edit and a missing set', async () => {
      const t = setupSessions();
      await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      expect(await t.repository.editSet(set.id, { reps: null })).toMatchObject({
        status: 'invalid',
        issues: [{ path: 'reps', code: 'reps-required' }],
      });
      expect(await t.repository.editSet('nao-existe', { reps: 3 })).toEqual({
        status: 'not-found',
      });
      expect(await t.outbox()).toHaveLength(2);
    });

    it('deletes a set by tombstone: the row stays and the PUT carries deleted true', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      const result = await t.repository.deleteSet(set.id);

      expect(result.status).toBe('saved');
      expect(await t.repository.setsOfSession(session.id)).toEqual([]);
      expect(await t.trainingDb.sets.get(set.id)).toMatchObject({ deletedAt: expect.any(Number) });
      const queued = await t.outbox();
      expect(queued.at(-1)).toMatchObject({
        method: 'PUT',
        url: expect.stringContaining(`/sets/${set.id}`),
      });
      expect(queued.at(-1)?.body).toMatchObject({ deleted: true });
      expect(await t.repository.deleteSet(set.id)).toEqual({ status: 'not-found' });
    });

    it('keeps the next position after a deleted set (no repeated position)', async () => {
      const t = setupSessions();
      await started(t);
      const first = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      await t.repository.deleteSet(first.id);

      const second = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      expect(second.position).toBe(1);
    });

    it('undoes the local write of a set when the queue has no space', async () => {
      const t = setupSessions();
      const session = await started(t);
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 });

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.repository.setsOfSession(session.id)).toEqual([]);
      expect(await t.trainingDb.sets.count()).toBe(0);
    });

    it('puts the previous version back when an edit or a delete cannot be queued', async () => {
      const t = setupSessions();
      await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.editSet(set.id, { reps: 12 })).toEqual({ status: 'storage-full' });
      expect(await t.repository.deleteSet(set.id)).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.sets.get(set.id)).toEqual(set);
      expect(await t.outbox()).toHaveLength(2);
    });
  });

  describe('finish and discard', () => {
    it('finish frees the device, clears the rest timer and queues the session again', async () => {
      const t = setupSessions();
      const session = await started(t);
      await t.trainingDb.meta.put({ key: 'restEndsAt', value: t.runtime.now() + 60_000 });
      t.runtime.advance(1_800_000);

      const result = await t.repository.finish({ feeling: 5, note: ' ótimo ' });

      expect(result).toMatchObject({
        status: 'saved',
        session: { id: session.id, feeling: 5, note: 'ótimo', finishedAt: t.runtime.now() },
      });
      expect(await t.repository.activeSession()).toBeUndefined();
      expect(await t.trainingDb.meta.get('restEndsAt')).toBeUndefined();
      expect(await t.repository.finish()).toEqual({ status: 'no-active-session' });
      expect((await t.repository.start()).status).toBe('started');
    });

    it('finish refuses a feeling out of range and keeps the session open', async () => {
      const t = setupSessions();
      await started(t);

      expect(await t.repository.finish({ feeling: 6 })).toEqual({
        status: 'invalid',
        issues: ['feeling-range'],
      });
      expect(await t.repository.activeSession()).toBeDefined();
      expect(await t.outbox()).toHaveLength(1);
    });

    it('finish undoes everything when the queue has no space, and the session stays open', async () => {
      const t = setupSessions();
      const session = await started(t);
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.finish()).toEqual({ status: 'storage-full' });

      expect(await t.repository.activeSession()).toMatchObject({
        id: session.id,
        finishedAt: null,
      });
      expect((await t.trainingDb.meta.get('activeSessionId'))?.value).toBe(session.id);
    });

    it('discard turns the session and its sets into tombstones, queueing only the session', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      const result = await t.repository.discard();

      expect(result.status).toBe('saved');
      expect(await t.repository.activeSession()).toBeUndefined();
      expect(await t.repository.get(session.id)).toBeUndefined();
      expect(await t.trainingDb.sessions.get(session.id)).toMatchObject({
        deletedAt: expect.any(Number),
      });
      expect(await t.trainingDb.sets.get(set.id)).toMatchObject({ deletedAt: expect.any(Number) });
      const queued = await t.outbox();
      expect(queued).toHaveLength(3);
      expect(queued.at(-1)?.url).toBe(`/api/v1/training/sessions/${session.id}`);
      expect(queued.at(-1)?.body).toMatchObject({ deleted: true });
    });

    it('closeElsewhere ends a session left open on another device, keeping its owner', async () => {
      const t = setupSessions();
      await t.trainingDb.sessions.put(
        toLocalSession(sessionDto('s-outro', { deviceId: 'tablet' })),
      );

      const result = await t.repository.closeElsewhere('s-outro');

      expect(result).toMatchObject({
        status: 'saved',
        session: { id: 's-outro', deviceId: 'tablet' },
      });
      expect(await t.repository.openSessionsElsewhere()).toEqual([]);
      expect((await t.outbox())[0].body).toMatchObject({ deviceId: 'tablet', deleted: false });
      expect((await t.repository.start()).status).toBe('started');
    });

    it('closeElsewhere does nothing with a session of this device or a missing one', async () => {
      const t = setupSessions();
      const session = await started(t);

      expect(await t.repository.closeElsewhere(session.id)).toEqual({ status: 'not-found' });
      expect(await t.repository.closeElsewhere('nao-existe')).toEqual({ status: 'not-found' });
    });
  });

  describe('reload in the middle of the workout', () => {
    it('recovers the active session, its sets and the skipped exercises from the device', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      await t.repository.setSkipped('agacha', true);

      // Outra instância do repositório sobre o mesmo banco: é o app reaberto.
      TestBed.resetTestingModule();
      const reopened = setupSessions(t.trainingDb);

      expect(await reopened.repository.activeSession()).toEqual(session);
      expect((await reopened.repository.setsOfSession(session.id)).map((row) => row.id)).toEqual([
        set.id,
      ]);
      expect(await reopened.repository.skippedExercises()).toEqual(['agacha']);
    });
  });

  describe('skipped exercises', () => {
    it('are remembered per active session and forgotten when it ends', async () => {
      const t = setupSessions();
      await started(t);

      await t.repository.setSkipped('agacha', true);
      await t.repository.setSkipped('supino', true);
      await t.repository.setSkipped('agacha', false);
      expect(await t.repository.skippedExercises()).toEqual(['supino']);

      await t.repository.finish();
      expect(await t.repository.skippedExercises()).toEqual([]);
      await t.repository.start();
      expect(await t.repository.skippedExercises()).toEqual([]);
    });
  });

  describe('queries', () => {
    it('sessionsBetween returns the live sessions that started in the range, oldest first', async () => {
      const t = setupSessions();
      const day = 86_400_000;
      const base = 1_760_000_000_000;
      await t.trainingDb.sessions.bulkPut([
        { ...toLocalSession(sessionDto('a')), startedAt: base },
        { ...toLocalSession(sessionDto('b')), startedAt: base + 2 * day },
        { ...toLocalSession(sessionDto('c', { deleted: true })), startedAt: base + day },
        { ...toLocalSession(sessionDto('d')), startedAt: base + 9 * day },
      ]);

      const rows = await t.repository.sessionsBetween(base, base + 3 * day);

      expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
      expect((await t.repository.sessionsBetween(base, base)).map((row) => row.id)).toEqual(['a']);
    });
  });

  describe('lastPerformance', () => {
    async function seedHistory(t: ReturnType<typeof setupSessions>) {
      const day = 86_400_000;
      const base = 1_760_000_000_000;
      const finishedAt = '2026-10-01T11:00:00Z';
      await t.trainingDb.sessions.bulkPut([
        { ...toLocalSession(sessionDto('velha', { finishedAt })), startedAt: base },
        { ...toLocalSession(sessionDto('ultima', { finishedAt })), startedAt: base + 3 * day },
        { ...toLocalSession(sessionDto('aberta')), startedAt: base + 5 * day },
        {
          ...toLocalSession(sessionDto('apagada', { finishedAt, deleted: true })),
          startedAt: base + 6 * day,
        },
      ]);
      const put = (
        id: string,
        sessionId: string,
        day: number,
        overrides: Parameters<typeof setDto>[2] = {},
      ) =>
        t.trainingDb.sets.put({
          ...toLocalSet(setDto(id, sessionId, overrides)),
          completedAt: base + day * 86_400_000 + 1000,
        });
      await put('velha-1', 'velha', 0, { weightKg: 60, reps: 10, position: 0 });
      await put('ultima-aq', 'ultima', 3, {
        setType: 'warmup',
        weightKg: 40,
        reps: 12,
        position: 0,
      });
      await put('ultima-1', 'ultima', 3, { weightKg: 80, reps: 8, position: 1 });
      await put('ultima-2', 'ultima', 3, { weightKg: 82.5, reps: 6, position: 2 });
      await put('ultima-x', 'ultima', 3, { weightKg: 90, reps: 3, position: 3, deleted: true });
      await put('aberta-1', 'aberta', 5, { weightKg: 100, reps: 5 });
      await put('apagada-1', 'apagada', 6, { weightKg: 110, reps: 5 });
      await put('outro-exercicio', 'ultima', 3, {
        exerciseId: 'agacha',
        weightKg: 120,
        reps: 5,
        position: 4,
      });
    }

    it('returns the work sets of the last finished session, ignoring open, deleted and warm-up', async () => {
      const t = setupSessions();
      await seedHistory(t);

      const last = await t.repository.lastPerformance('supino');

      expect(last?.sessionId).toBe('ultima');
      expect(last?.sets.map((row) => [row.id, row.weightKg, row.reps])).toEqual([
        ['ultima-1', 80, 8],
        ['ultima-2', 82.5, 6],
      ]);
    });

    it('is null when the exercise only has open, deleted or warm-up history', async () => {
      const t = setupSessions();
      await seedHistory(t);
      await t.trainingDb.sets.put({
        ...toLocalSet(setDto('so-aq', 'ultima', { exerciseId: 'flexao', setType: 'warmup' })),
      });

      expect(await t.repository.lastPerformance('flexao')).toBeNull();
      expect(await t.repository.lastPerformance('prancha')).toBeNull();
    });

    it('looks past the first page of the history to find a finished session', async () => {
      const t = setupSessions();
      await t.trainingDb.sessions.bulkPut([
        {
          ...toLocalSession(sessionDto('boa', { finishedAt: '2026-10-01T11:00:00Z' })),
          startedAt: 1000,
        },
        { ...toLocalSession(sessionDto('aberta')), startedAt: 2000 },
      ]);
      await t.trainingDb.sets.put({ ...toLocalSet(setDto('s-boa', 'boa')), completedAt: 1500 });
      // 120 séries recentes, todas da sessão aberta: a busca precisa passar de uma página inteira para chegar à boa.
      await t.trainingDb.sets.bulkPut(
        Array.from({ length: 120 }, (_, i) => ({
          ...toLocalSet(setDto(`s-ab-${i}`, 'aberta')),
          completedAt: 10_000 + i,
        })),
      );

      const last = await t.repository.lastPerformance('supino');

      expect(last?.sessionId).toBe('boa');
    });
  });

  describe('merging what the server sends', () => {
    it('keeps a local session the server does not know about, and applies a newer remote one', async () => {
      const t = setupSessions();
      const session = await started(t);

      await t.repository.applyRemoteSessions([
        toLocalSession(
          sessionDto('remota', { deviceId: 'tablet', finishedAt: '2026-10-01T11:00:00Z' }),
        ),
      ]);

      expect(await t.trainingDb.sessions.get(session.id)).toEqual(session);
      expect(await t.trainingDb.sessions.get('remota')).toBeDefined();
    });

    it('lets the newer local edit win over an older remote one, and the remote win on a tie', async () => {
      const t = setupSessions();
      await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      await t.repository.applyRemoteSets([
        { ...set, weightKg: 1, clientUpdatedAt: set.clientUpdatedAt - 10 },
      ]);
      expect((await t.trainingDb.sets.get(set.id))?.weightKg).toBe(80);

      await t.repository.applyRemoteSets([{ ...set, weightKg: 77 }]);
      expect((await t.trainingDb.sets.get(set.id))?.weightKg).toBe(77);
    });

    it('a remote tombstone of a session deletes the local sets and frees the device', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );

      await t.repository.applyRemoteSessions([
        {
          ...session,
          deletedAt: session.clientUpdatedAt + 1000,
          clientUpdatedAt: session.clientUpdatedAt + 1000,
        },
      ]);

      expect(await t.trainingDb.sets.get(set.id)).toMatchObject({ deletedAt: expect.any(Number) });
      expect(await t.repository.setsOfSession(session.id)).toEqual([]);
      expect(await t.repository.activeSession()).toBeUndefined();
    });

    it('a session finished elsewhere stops being the active one', async () => {
      const t = setupSessions();
      const session = await started(t);

      await t.repository.applyRemoteSessions([
        {
          ...session,
          finishedAt: session.startedAt + 1000,
          clientUpdatedAt: session.clientUpdatedAt + 1000,
        },
      ]);

      expect(await t.repository.activeSession()).toBeUndefined();
    });
  });

  describe('resendSession', () => {
    it('resends a refused workout as new requests, because the server keeps a refusal per key', async () => {
      const t = setupSessions();
      const session = await started(t);
      const first = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      const second = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 82.5, reps: 6 }),
      );
      await t.repository.finish({ feeling: 4 });
      const original = await t.outbox();

      // Outro aparelho tinha um treino aberto: o treino é recusado (409) e as séries ficam sem treino (404); o fim passa.
      t.transport.script = [
        problem(409, 'session-already-open'),
        problem(404, 'session-not-found'),
        problem(404, 'session-not-found'),
        ok(200),
      ];
      t.resume();
      await t.queue().syncNow();
      expect((await t.outbox()).map((item) => item.status)).toEqual(['failed', 'failed', 'failed']);

      // O outro aparelho foi encerrado; agora o treino inteiro sobe de novo.
      t.transport.requests.length = 0;
      t.pause();
      const result = await t.repository.resendSession(session.id);

      expect(result).toEqual({ status: 'queued', requests: 3 });
      const queued = await t.outbox();
      expect(queued.map((item) => item.status)).toEqual(['pending', 'pending', 'pending']);
      expect(queued.map((item) => item.url)).toEqual([
        `/api/v1/training/sessions/${session.id}`,
        `/api/v1/training/sessions/${session.id}/sets/${first.id}`,
        `/api/v1/training/sessions/${session.id}/sets/${second.id}`,
      ]);
      // Chaves novas: a recusa antiga não é repetida.
      const oldKeys = original.map((item) => item.id);
      expect(queued.every((item) => !oldKeys.includes(item.id))).toBe(true);
      expect(queued[0].body).toMatchObject({ feeling: 4, deleted: false });
      expect((queued[0].body as { finishedAt: string | null }).finishedAt).not.toBeNull();

      t.resume();
      await t.queue().syncNow();
      expect(t.transport.requests.map((request) => request.url)).toEqual(
        queued.map((item) => item.url),
      );
      expect(await t.outbox()).toEqual([]);
    });

    it('keeps what is still waiting and what belongs to other sessions', async () => {
      const t = setupSessions();
      const session = await started(t);
      await t.repository.finish();
      const other = await t.repository.start();
      if (other.status !== 'started') throw new Error('esperava abrir outro treino');
      const before = await t.outbox();

      await t.repository.resendSession(session.id);

      const queued = await t.outbox();
      expect(queued.slice(0, before.length).map((item) => item.id)).toEqual(
        before.map((item) => item.id),
      );
      expect(queued).toHaveLength(before.length + 1);
    });

    it('resends only the tombstone of a discarded session', async () => {
      const t = setupSessions();
      const session = await started(t);
      await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 });
      await t.repository.discard();
      const before = (await t.outbox()).length;

      const result = await t.repository.resendSession(session.id);

      expect(result).toEqual({ status: 'queued', requests: 1 });
      const queued = await t.outbox();
      expect(queued).toHaveLength(before + 1);
      expect(queued.at(-1)?.body).toMatchObject({ deleted: true });
    });

    it('says not-found for a session this device does not have', async () => {
      const t = setupSessions();

      expect(await t.repository.resendSession('nao-existe')).toEqual({ status: 'not-found' });
    });

    it('takes back what it queued when the device runs out of space halfway', async () => {
      const t = setupSessions();
      const session = await started(t);
      await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 });
      const before = await t.outbox();
      const original = t.db.outbox.add.bind(t.db.outbox) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let calls = 0;
      vi.spyOn(t.db.outbox, 'add').mockImplementation(((...args: unknown[]) => {
        calls++;
        return calls === 2 ? Promise.reject(quota()) : original(...args);
      }) as never);

      const result = await t.repository.resendSession(session.id);

      expect(result).toEqual({ status: 'storage-full' });
      expect((await t.outbox()).map((item) => item.id)).toEqual(before.map((item) => item.id));
    });
  });

  describe('401 and logout', () => {
    it('never remove anything from the queue or from the local database', async () => {
      const t = setupSessions();
      const session = await started(t);
      const set = savedSet(
        await t.repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 }),
      );
      await t.repository.finish({ feeling: 3 });

      // O servidor responde 401 a tudo: os itens ficam pendentes (sem contar como falha).
      t.transport.fallback = ok(401);
      t.resume();
      await t.queue().syncNow();
      expect(await t.outbox()).toHaveLength(3);
      expect((await t.outbox()).every((item) => item.status === 'pending')).toBe(true);

      // E o logout (sessão anônima) também não apaga nada.
      TestBed.inject(SessionState).clear('anonymous');
      await t.queue().syncNow();

      const queued = await t.outbox();
      expect(queued).toHaveLength(3);
      expect(queued.map((item) => item.url)).toEqual([
        `/api/v1/training/sessions/${session.id}`,
        `/api/v1/training/sessions/${session.id}/sets/${set.id}`,
        `/api/v1/training/sessions/${session.id}`,
      ]);
      expect(await t.trainingDb.sessions.get(session.id)).toMatchObject({ feeling: 3 });
      expect(await t.trainingDb.sets.get(set.id)).toMatchObject({ weightKg: 80 });
      expect((await t.trainingDb.meta.get('deviceId'))?.value).toBeTypeOf('string');
    });
  });
});
