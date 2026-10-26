import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { isUuid } from '../../../../core/offline-queue/uuid-v7';
import { networkError } from '../../../../core/offline-queue/queue-test-kit';
import { shape } from '../../domain/routines/routine-test-kit';
import { createTrainingTestDb, localExercise } from '../sync/training-test-kit';
import { exclusiveLocks, grantEverything, installLocks, removeLocks } from '../tab-lock-test-kit';
import { TRAINING_DB, TrainingDb } from '../training-db';
import {
  PARTIAL_DRAFT_TEMPLATE_IDS,
  RoutineRepository,
  type RoutineDraft,
  type RoutineDraftItem,
  type RoutineWriteResult,
} from './routine-repository';
import { toLocalRoutine } from './routine';
import { routineDto, seedCatalog, setupRoutines, TEMPLATES_DTO } from './routine-data-test-kit';

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

const draftItem = (
  exerciseId: string,
  extra: Partial<RoutineDraftItem> = {},
): RoutineDraftItem => ({
  exerciseId,
  targetSets: 4,
  repMin: 6,
  repMax: 10,
  restSeconds: 120,
  ...extra,
});

const DRAFT: RoutineDraft = {
  name: '  A · Peito  ',
  items: [draftItem('supino'), draftItem('crucifixo', { targetSets: 3, note: '  devagar  ' })],
};

function savedRoutine(result: RoutineWriteResult) {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.routine;
}

/** Deixa a primeira entrada na fila passar e faz a segunda falhar por falta de espaço. */
function failSecondEnqueue(t: ReturnType<typeof setupRoutines>) {
  const original = t.db.outbox.add.bind(t.db.outbox) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  vi.spyOn(t.db.outbox, 'add').mockImplementation(((...args: unknown[]) => {
    calls++;
    return calls === 2 ? Promise.reject(quota()) : original(...args);
  }) as never);
}

describe('RoutineRepository', () => {
  describe('save', () => {
    it('writes to the device first and queues exactly one PUT of the whole routine', async () => {
      const t = setupRoutines();

      const routine = savedRoutine(await t.repository.save(DRAFT));

      expect(isUuid(routine.id)).toBe(true);
      expect(routine.id[14]).toBe('7');
      const stored = await t.repository.get(routine.id);
      expect(stored).toMatchObject({
        name: 'A · Peito',
        position: 0,
        active: true,
        note: '',
        deletedAt: null,
      });
      expect(stored?.items.map((entry) => [entry.exerciseId, entry.position])).toEqual([
        ['supino', 0],
        ['crucifixo', 1],
      ]);
      expect(stored?.items.every((entry) => isUuid(entry.id) && entry.id[14] === '7')).toBe(true);
      expect(stored?.items[1].note).toBe('devagar');

      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: `/api/v1/training/routines/${routine.id}`,
        module: 'training',
        status: 'pending',
        attempts: 0,
      });
      expect(queued[0].body).toEqual({
        name: 'A · Peito',
        position: 0,
        active: true,
        note: null,
        programId: null,
        weekdays: null,
        items: stored?.items.map((entry) => ({
          id: entry.id,
          exerciseId: entry.exerciseId,
          position: entry.position,
          targetSets: entry.targetSets,
          repMin: entry.repMin,
          repMax: entry.repMax,
          restSeconds: entry.restSeconds,
          supersetGroup: null,
          note: entry.note === '' ? null : entry.note,
        })),
        clientUpdatedAt: new Date(t.runtime.now()).toISOString(),
        deleted: false,
      });
      expect(t.queue().pendingCount()).toBe(1);
    });

    it('a new routine goes to the end of the sequence', async () => {
      const t = setupRoutines();

      const a = savedRoutine(await t.repository.save({ ...DRAFT, name: 'A' }));
      const b = savedRoutine(await t.repository.save({ ...DRAFT, name: 'B' }));
      const c = savedRoutine(await t.repository.save({ ...DRAFT, name: 'C', position: 9 }));

      expect([a.position, b.position, c.position]).toEqual([0, 1, 9]);
    });

    it('the order of the draft is the order of the routine, and the supersets are normalized', async () => {
      const t = setupRoutines();

      const routine = savedRoutine(
        await t.repository.save({
          name: 'A',
          items: [
            draftItem('a', { supersetGroup: 7 }),
            draftItem('b', { supersetGroup: 3 }),
            draftItem('c', { supersetGroup: 3 }),
            draftItem('d'),
          ],
        }),
      );

      expect(
        routine.items.map((entry) => [entry.exerciseId, entry.position, entry.supersetGroup]),
      ).toEqual([
        ['a', 0, null],
        ['b', 1, 1],
        ['c', 2, 1],
        ['d', 3, null],
      ]);
    });

    it('editing keeps the id, moves the clock forward and queues the PUT again', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));

      const edited = savedRoutine(
        await t.repository.save({
          ...DRAFT,
          id: created.id,
          name: 'A editada',
          items: [draftItem('supino')],
        }),
      );

      expect(edited.id).toBe(created.id);
      expect(edited.clientUpdatedAt).toBeGreaterThan(created.clientUpdatedAt);
      expect(edited.position).toBe(created.position);
      expect((await t.repository.get(created.id))?.items).toHaveLength(1);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued.every((entry) => entry.url.endsWith(created.id))).toBe(true);
      expect((queued[1].body as { name: string }).name).toBe('A editada');
    });

    it('editing keeps the ids of the items that continue', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      const [first] = created.items;

      const edited = savedRoutine(
        await t.repository.save({
          id: created.id,
          name: 'A',
          items: [{ ...draftItem('supino'), id: first.id }, draftItem('novo')],
        }),
      );

      expect(edited.items[0].id).toBe(first.id);
      expect(edited.items[1].id).not.toBe(first.id);
    });

    it('refuses an invalid draft before touching the device or the queue', async () => {
      const t = setupRoutines();
      const many = Array.from({ length: 41 }, (_, index) => draftItem(`e${index}`));

      await expect(t.repository.save({ ...DRAFT, name: '   ' })).rejects.toThrow(TypeError);
      await expect(t.repository.save({ ...DRAFT, name: 'x'.repeat(81) })).rejects.toThrow(
        TypeError,
      );
      await expect(t.repository.save({ ...DRAFT, items: many })).rejects.toThrow(TypeError);
      await expect(
        t.repository.save({ ...DRAFT, items: [draftItem('a', { targetSets: 0 })] }),
      ).rejects.toThrow(TypeError);
      await expect(
        t.repository.save({ ...DRAFT, items: [draftItem('a', { repMin: 12, repMax: 8 })] }),
      ).rejects.toThrow(TypeError);

      expect(await t.trainingDb.routines.count()).toBe(0);
      expect(await t.outbox()).toEqual([]);
    });

    it('does not edit a missing or deleted routine', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      await t.repository.softDelete(created.id);

      expect(await t.repository.save({ ...DRAFT, id: 'inexistente' })).toEqual({
        status: 'not-found',
      });
      expect(await t.repository.save({ ...DRAFT, id: created.id })).toEqual({
        status: 'not-found',
      });
      expect(await t.outbox()).toHaveLength(2);
    });

    it('reuses the same idempotency key on every attempt of the same item', async () => {
      const t = setupRoutines();
      t.transport.script = [networkError()];
      await t.repository.save(DRAFT);
      const [queued] = await t.outbox();

      t.resume();
      await t.queue().syncNow();
      await t.queue().syncNow();

      expect(t.transport.requests).toHaveLength(2);
      expect(t.transport.keys).toEqual([queued.id, queued.id]);
      expect(t.transport.requests.every((r) => r.url === queued.url && r.method === 'PUT')).toBe(
        true,
      );
      expect(await t.outbox()).toEqual([]);
    });
  });

  describe('when the device has no space for the queue item', () => {
    it('undoes the local write of a new routine and says so', async () => {
      const t = setupRoutines();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.repository.save(DRAFT);

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.trainingDb.routines.count()).toBe(0);
      expect(await t.repository.list()).toEqual([]);
      expect(t.queue().pendingCount()).toBe(0);
    });

    it('puts the previous version back when an edit cannot be queued', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.repository.save({ ...DRAFT, id: created.id, name: 'Perdida' });

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.repository.get(created.id)).toEqual(created);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('does not undo what changed in the meantime', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      vi.spyOn(t.db.outbox, 'add').mockImplementation((async () => {
        // Outra escrita mexeu na linha enquanto a fila recusava.
        await t.trainingDb.routines.put({
          ...created,
          name: 'Outra aba',
          clientUpdatedAt: created.clientUpdatedAt + 999,
        });
        throw quota();
      }) as never);

      await t.repository.save({ ...DRAFT, id: created.id, name: 'Perdida' });

      expect((await t.repository.get(created.id))?.name).toBe('Outra aba');
    });

    it('rethrows an error that is not about space, after undoing the local write', async () => {
      const t = setupRoutines();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(new Error('quebrou'));

      await expect(t.repository.save(DRAFT)).rejects.toThrow('quebrou');

      expect(await t.trainingDb.routines.count()).toBe(0);
    });
  });

  describe('reads', () => {
    it('lists the live and active routines by position, hiding tombstones', async () => {
      const t = setupRoutines();
      const c = savedRoutine(await t.repository.save({ ...DRAFT, name: 'C', position: 2 }));
      const a = savedRoutine(await t.repository.save({ ...DRAFT, name: 'A', position: 0 }));
      const b = savedRoutine(await t.repository.save({ ...DRAFT, name: 'B', position: 1 }));
      await t.repository.save({ ...DRAFT, id: b.id, name: 'B', active: false });
      const d = savedRoutine(await t.repository.save({ ...DRAFT, name: 'D', position: 3 }));
      await t.repository.softDelete(d.id);

      expect((await t.repository.list()).map((row) => row.name)).toEqual(['A', 'C']);
      expect((await t.repository.listAll()).map((row) => row.name)).toEqual(['A', 'B', 'C']);
      expect((await t.repository.all()).map((row) => row.name)).toEqual(['A', 'B', 'C', 'D']);
      expect(await t.repository.get(d.id)).toBeUndefined();
      expect((await t.repository.readRaw(d.id))?.deletedAt).not.toBeNull();
      expect(await t.repository.get(a.id)).toBeDefined();
      expect(c.position).toBe(2);
    });

    it('signals each local write through the revision', async () => {
      const t = setupRoutines();
      const before = t.repository.revision();

      await t.repository.save(DRAFT);

      expect(t.repository.revision()).toBeGreaterThan(before);
    });
  });

  describe('softDelete', () => {
    it('keeps a tombstone, hides the routine and queues a PUT with deleted true', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));

      const result = await t.repository.softDelete(created.id);

      expect(savedRoutine(result).deletedAt).not.toBeNull();
      expect(await t.repository.get(created.id)).toBeUndefined();
      expect(await t.trainingDb.routines.count()).toBe(1);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued[1]).toMatchObject({
        method: 'PUT',
        url: `/api/v1/training/routines/${created.id}`,
      });
      expect((queued[1].body as { deleted: boolean }).deleted).toBe(true);
    });

    it('answers not-found for a missing or already deleted routine', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      await t.repository.softDelete(created.id);

      expect(await t.repository.softDelete(created.id)).toEqual({ status: 'not-found' });
      expect(await t.repository.softDelete('inexistente')).toEqual({ status: 'not-found' });
      expect(await t.outbox()).toHaveLength(2);
    });

    it('undoes the tombstone when the queue refuses', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.softDelete(created.id)).toEqual({ status: 'storage-full' });

      expect(await t.repository.get(created.id)).toEqual(created);
    });
  });

  describe('reorder', () => {
    async function threeRoutines(t: ReturnType<typeof setupRoutines>) {
      const a = savedRoutine(await t.repository.save({ ...DRAFT, name: 'A' }));
      const b = savedRoutine(await t.repository.save({ ...DRAFT, name: 'B' }));
      const c = savedRoutine(await t.repository.save({ ...DRAFT, name: 'C' }));
      return { a, b, c };
    }

    it('rewrites only the positions that changed, one PUT each', async () => {
      const t = setupRoutines();
      const { a, b, c } = await threeRoutines(t);
      const before = (await t.outbox()).length;

      const result = await t.repository.reorder([b.id, a.id, c.id]);

      expect(result.status).toBe('saved');
      expect((await t.repository.list()).map((row) => row.name)).toEqual(['B', 'A', 'C']);
      const queued = (await t.outbox()).slice(before);
      expect(queued.map((entry) => entry.url)).toEqual([
        `/api/v1/training/routines/${b.id}`,
        `/api/v1/training/routines/${a.id}`,
      ]);
      expect(queued.map((entry) => (entry.body as { position: number }).position)).toEqual([0, 1]);
    });

    it('puts the routines that were not named after the named ones', async () => {
      const t = setupRoutines();
      const { a, b, c } = await threeRoutines(t);

      await t.repository.reorder([c.id]);

      expect((await t.repository.list()).map((row) => row.id)).toEqual([c.id, a.id, b.id]);
    });

    it('ignores unknown and deleted ids, and writes nothing when the order is the same', async () => {
      const t = setupRoutines();
      const { a, b, c } = await threeRoutines(t);
      const before = (await t.outbox()).length;

      expect(await t.repository.reorder([a.id, 'nao-existe', b.id, c.id, a.id])).toEqual({
        status: 'saved',
        routines: [],
      });
      expect(await t.outbox()).toHaveLength(before);
    });

    it('is all or nothing when the queue runs out of space midway', async () => {
      const t = setupRoutines();
      const { a, b, c } = await threeRoutines(t);
      const before = await t.outbox();
      failSecondEnqueue(t);

      const result = await t.repository.reorder([c.id, b.id, a.id]);

      expect(result).toEqual({ status: 'storage-full' });
      expect((await t.repository.list()).map((row) => row.name)).toEqual(['A', 'B', 'C']);
      expect((await t.outbox()).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    });
  });

  describe('addExercise', () => {
    it('appends the exercise with the default goal and queues one PUT', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));

      const updated = savedRoutine(await t.repository.addExercise(created.id, 'remada'));

      expect(updated.items).toHaveLength(3);
      expect(updated.items[2]).toMatchObject({
        exerciseId: 'remada',
        position: 2,
        targetSets: 3,
        repMin: 8,
        repMax: 12,
        restSeconds: 90,
        supersetGroup: null,
        note: '',
      });
      expect(isUuid(updated.items[2].id)).toBe(true);
      expect(await t.outbox()).toHaveLength(2);
    });

    it('works on an empty routine and refuses a full one', async () => {
      const t = setupRoutines();
      const empty = savedRoutine(await t.repository.save({ name: 'Vazia', items: [] }));
      expect(savedRoutine(await t.repository.addExercise(empty.id, 'x')).items).toHaveLength(1);

      const full = savedRoutine(
        await t.repository.save({
          name: 'Cheia',
          items: Array.from({ length: 40 }, (_, index) => draftItem(`e${index}`)),
        }),
      );
      const queued = (await t.outbox()).length;

      expect(await t.repository.addExercise(full.id, 'mais')).toEqual({ status: 'routine-full' });
      expect(await t.outbox()).toHaveLength(queued);
    });

    it('answers not-found for a missing or deleted routine', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      await t.repository.softDelete(created.id);

      expect(await t.repository.addExercise('inexistente', 'x')).toEqual({ status: 'not-found' });
      expect(await t.repository.addExercise(created.id, 'x')).toEqual({ status: 'not-found' });
    });

    it('undoes the addition when the queue refuses', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.addExercise(created.id, 'remada')).toEqual({
        status: 'storage-full',
      });

      expect(await t.repository.get(created.id)).toEqual(created);
    });
  });

  describe('moveItem and toggleSuperset', () => {
    async function withThree(t: ReturnType<typeof setupRoutines>) {
      return savedRoutine(
        await t.repository.save({
          name: 'A',
          items: [draftItem('a'), draftItem('b'), draftItem('c')],
        }),
      );
    }

    it('moves an item and queues one PUT with the new order', async () => {
      const t = setupRoutines();
      const created = await withThree(t);

      const updated = savedRoutine(await t.repository.moveItem(created.id, created.items[0].id, 2));

      expect(updated.items.map((entry) => entry.exerciseId)).toEqual(['b', 'c', 'a']);
      expect(updated.items.map((entry) => entry.position)).toEqual([0, 1, 2]);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(
        (queued[1].body as { items: { exerciseId: string }[] }).items.map(
          (entry) => entry.exerciseId,
        ),
      ).toEqual(['b', 'c', 'a']);
    });

    it('does not queue anything when the move changes nothing', async () => {
      const t = setupRoutines();
      const created = await withThree(t);

      const result = await t.repository.moveItem(created.id, created.items[0].id, 0);

      expect(savedRoutine(result)).toEqual(created);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('answers not-found for an unknown item or routine', async () => {
      const t = setupRoutines();
      const created = await withThree(t);

      expect(await t.repository.moveItem(created.id, 'nenhum', 0)).toEqual({ status: 'not-found' });
      expect(await t.repository.moveItem('nenhuma', created.items[0].id, 0)).toEqual({
        status: 'not-found',
      });
      expect(await t.repository.toggleSuperset(created.id, 'nenhum')).toEqual({
        status: 'not-found',
      });
    });

    it('joins an item with the next one and separates it again, one PUT each time', async () => {
      const t = setupRoutines();
      const created = await withThree(t);

      const joined = savedRoutine(
        await t.repository.toggleSuperset(created.id, created.items[0].id),
      );
      expect(joined.items.map((entry) => entry.supersetGroup)).toEqual([1, 1, null]);

      const split = savedRoutine(
        await t.repository.toggleSuperset(created.id, created.items[0].id),
      );
      expect(split.items.map((entry) => entry.supersetGroup)).toEqual([null, null, null]);
      expect(await t.outbox()).toHaveLength(3);
    });

    it('does nothing (and sends nothing) on the last item', async () => {
      const t = setupRoutines();
      const created = await withThree(t);

      const result = await t.repository.toggleSuperset(created.id, created.items[2].id);

      expect(savedRoutine(result)).toEqual(created);
      expect(await t.outbox()).toHaveLength(1);
    });
  });

  describe('createFromTemplate', () => {
    const SLUGS = ['supino', 'crucifixo', 'rosca', 'triceps'];

    it('creates one routine per day, at the end of the sequence, with new UUID v7 ids', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);
      const existing = savedRoutine(await t.repository.save({ ...DRAFT, name: 'Minha' }));

      const result = await t.repository.createFromTemplate('duplo');

      if (result.status !== 'saved') throw new Error(result.status);
      expect(result.missing).toEqual([]);
      expect(result.routines.map((row) => [row.name, row.position])).toEqual([
        ['A · Peito', existing.position + 1],
        ['B · Braços', existing.position + 2],
      ]);
      expect(
        result.routines.every((row) => isUuid(row.id) && row.id[14] === '7' && row.active),
      ).toBe(true);
      const [a, b] = result.routines;
      expect(
        a.items.map((entry) => [
          entry.exerciseId,
          entry.targetSets,
          entry.repMin,
          entry.repMax,
          entry.restSeconds,
        ]),
      ).toEqual([
        ['id-supino', 4, 6, 10, 120],
        ['id-crucifixo', 3, 10, 15, 60],
      ]);
      expect(a.items.every((entry) => isUuid(entry.id))).toBe(true);
      expect(shape(b.items.map((entry) => ({ ...entry, id: entry.exerciseId })))).toEqual([
        ['id-rosca', 1],
        ['id-triceps', 1],
      ]);
      expect(
        new Set([a.id, b.id, ...a.items.map((e) => e.id), ...b.items.map((e) => e.id)]).size,
      ).toBe(6);

      const queued = (await t.outbox()).slice(1);
      expect(queued).toHaveLength(2);
      expect(queued.map((entry) => entry.url)).toEqual([
        `/api/v1/training/routines/${a.id}`,
        `/api/v1/training/routines/${b.id}`,
      ]);
    });

    it('keeps every known partial draft inactive while ordinary templates stay active', async () => {
      expect(PARTIAL_DRAFT_TEMPLATE_IDS).toContain('historical-ab');
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);
      t.api.dto = {
        items: PARTIAL_DRAFT_TEMPLATE_IDS.map((id) => ({ ...TEMPLATES_DTO.items[0], id })),
      };

      for (const id of PARTIAL_DRAFT_TEMPLATE_IDS) {
        const result = await t.repository.createFromTemplate(id);
        if (result.status !== 'saved') throw new Error(`esperava saved para ${id}`);
        expect(result.routines).toHaveLength(2);
        expect(result.routines.every((routine) => !routine.active)).toBe(true);
      }

      expect(await t.trainingDb.routines.count()).toBe(PARTIAL_DRAFT_TEMPLATE_IDS.length * 2);
    });

    it('creating the same template twice gives different ids each time', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);

      const first = await t.repository.createFromTemplate('duplo');
      const second = await t.repository.createFromTemplate('duplo');

      if (first.status !== 'saved' || second.status !== 'saved') throw new Error('esperava saved');
      expect(new Set([...first.routines, ...second.routines].map((row) => row.id)).size).toBe(4);
      expect(second.routines[0].position).toBe(first.routines[1].position + 1);
    });

    it('uses the exercises it found and reports the ones missing from the local catalog', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, ['supino', 'rosca']);

      const result = await t.repository.createFromTemplate('duplo');

      if (result.status !== 'saved') throw new Error(result.status);
      expect(result.missing).toEqual(['crucifixo', 'triceps']);
      expect(result.routines.map((row) => row.items.map((entry) => entry.exerciseId))).toEqual([
        ['id-supino'],
        ['id-rosca'],
      ]);
      // O parceiro da supersérie faltou: o item que ficou sozinho não vira supersérie.
      expect(result.routines[1].items[0].supersetGroup).toBeNull();
      expect(await t.outbox()).toHaveLength(2);
    });

    it('skips a day with no exercise found', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, ['rosca', 'triceps']);

      const partial = await t.repository.createFromTemplate('duplo');

      if (partial.status !== 'saved') throw new Error(partial.status);
      expect(partial.routines.map((row) => row.name)).toEqual(['B · Braços']);
      expect(partial.missing).toEqual(['supino', 'crucifixo']);
    });

    it('says no-exercises, and writes nothing, when no day can be built', async () => {
      const t = setupRoutines();

      const none = await t.repository.createFromTemplate('duplo');

      expect(none).toEqual({ status: 'no-exercises', missing: SLUGS });
      expect(await t.trainingDb.routines.count()).toBe(0);
      expect(await t.outbox()).toEqual([]);
    });

    it('never uses an own exercise or a deleted one', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, ['supino'], { source: 'own' });
      await seedCatalog(t.trainingDb, ['rosca'], { deleted: true });

      const result = await t.repository.createFromTemplate('duplo');

      expect(result).toEqual({ status: 'no-exercises', missing: SLUGS });
    });

    it('prefers the origin catalog when two sources share a slug', async () => {
      const t = setupRoutines();
      await t.trainingDb.exercises.bulkPut([
        localExercise('wger-supino', { slug: 'supino', source: 'wger' }),
        localExercise('origem-supino', { slug: 'supino', source: 'free_exercise_db' }),
      ]);

      const result = await t.repository.createFromTemplate('duplo');

      if (result.status !== 'saved') throw new Error(result.status);
      expect(result.routines[0].items[0].exerciseId).toBe('origem-supino');
    });

    it('answers template-not-found for an unknown template, and writes nothing', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);

      expect(await t.repository.createFromTemplate('inexistente')).toEqual({
        status: 'template-not-found',
      });
      expect(await t.trainingDb.routines.count()).toBe(0);
    });

    it('is all or nothing when the queue runs out of space midway', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);
      failSecondEnqueue(t);

      const result = await t.repository.createFromTemplate('duplo');

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.trainingDb.routines.count()).toBe(0);
      expect(await t.outbox()).toEqual([]);
    });
  });

  describe('selectProgram', () => {
    const SLUGS = ['supino', 'crucifixo', 'rosca', 'triceps'];

    /** O modelo "duplo" com os dias da semana (segunda e quarta) e um segundo modelo, para trocar de programa. */
    function withPrograms(t: ReturnType<typeof setupRoutines>) {
      const [duplo] = TEMPLATES_DTO.items;
      t.api.dto = {
        items: [
          {
            ...duplo,
            routines: duplo.routines.map((day, index) => ({
              ...day,
              weekdays: [index === 0 ? 1 : 3],
            })),
          },
          {
            ...duplo,
            id: 'outro',
            name: 'Outro',
            routines: duplo.routines
              .slice(0, 1)
              .map((day) => ({ ...day, name: 'Terça · X', weekdays: [2] })),
          },
        ],
      };
    }

    it('saves the routines (active, with program and weekdays), the choice, and queues them: routines first, then the program', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);

      const result = await t.repository.selectProgram('duplo');

      if (result.status !== 'saved') throw new Error(result.status);
      expect(result.routines.map((row) => [row.programId, row.weekdays, row.active])).toEqual([
        ['duplo', [1], true],
        ['duplo', [3], true],
      ]);
      expect(await t.repository.activeProgramId()).toBe('duplo');
      const queued = await t.outbox();
      expect(queued.map((entry) => entry.method)).toEqual(['PUT', 'PUT', 'PUT']);
      expect(
        queued.map((entry) =>
          entry.url.replace(/.*\/training\//, '').replace(/[0-9a-f-]{36}/, ':id'),
        ),
      ).toEqual(['routines/:id', 'routines/:id', 'program']);
      expect(queued[0].body).toMatchObject({ programId: 'duplo', weekdays: [1], active: true });
      expect(queued[2].body).toMatchObject({ programId: 'duplo' });
    });

    it('works with no network at all, from the cached templates, and everything waits in the queue', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);
      await t.repository.templates();
      t.api.failing = true;

      const result = await t.repository.selectProgram('duplo');

      expect(result.status).toBe('saved');
      expect(await t.repository.activeProgramId()).toBe('duplo');
      expect(await t.outbox()).toHaveLength(3);
    });

    it('says the templates are unavailable when neither the network nor the cache has them', async () => {
      const t = setupRoutines();
      t.api.failing = true;

      expect((await t.repository.selectProgram('duplo')).status).toBe('templates-unavailable');
      expect(await t.repository.activeProgramId()).toBeNull();
      expect(await t.outbox()).toEqual([]);
    });

    it('never makes the rejected historical template a program', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, SLUGS);

      expect(await t.repository.selectProgram('historical-ab')).toEqual({
        status: 'template-not-found',
      });
    });

    it('switching deactivates the previous program (kept), and choosing it again reactivates without duplicating', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);
      await t.repository.selectProgram('duplo');

      await t.repository.selectProgram('outro');
      const afterSwitch = await t.repository.listAll();
      expect(afterSwitch.map((row) => [row.programId, row.active])).toEqual([
        ['duplo', false],
        ['duplo', false],
        ['outro', true],
      ]);
      expect(await t.repository.activeProgramId()).toBe('outro');

      await t.repository.selectProgram('duplo');
      const afterBack = await t.repository.listAll();
      expect(afterBack).toHaveLength(3);
      expect(afterBack.map((row) => [row.programId, row.active])).toEqual([
        ['duplo', true],
        ['duplo', true],
        ['outro', false],
      ]);
      expect(await t.repository.activeProgramId()).toBe('duplo');
    });

    it('recreates the routines of the program when they were all deleted', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);
      const first = await t.repository.selectProgram('duplo');
      if (first.status !== 'saved') throw new Error(first.status);
      for (const row of first.routines) await t.repository.softDelete(row.id);

      const again = await t.repository.selectProgram('duplo');

      if (again.status !== 'saved') throw new Error(again.status);
      expect(again.routines).toHaveLength(2);
      expect((await t.repository.list()).map((row) => row.programId)).toEqual(['duplo', 'duplo']);
    });

    it('leaves nothing behind when the queue is full', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);
      failSecondEnqueue(t);

      expect(await t.repository.selectProgram('duplo')).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.routines.count()).toBe(0);
      expect(await t.repository.activeProgramId()).toBeNull();
      expect(await t.outbox()).toEqual([]);
    });

    it('editing a program routine keeps its program and weekdays', async () => {
      const t = setupRoutines();
      withPrograms(t);
      await seedCatalog(t.trainingDb, SLUGS);
      const result = await t.repository.selectProgram('duplo');
      if (result.status !== 'saved') throw new Error(result.status);
      const [first] = result.routines;

      const saved = savedRoutine(
        await t.repository.save({
          id: first.id,
          name: 'Segunda · Nova',
          items: [draftItem('supino')],
        }),
      );

      expect([saved.programId, saved.weekdays]).toEqual(['duplo', [1]]);
      expect((await t.repository.get(first.id))?.programId).toBe('duplo');
    });

    it('takes the choice made on another device when it is newer, and keeps its own when it is older', async () => {
      const t = setupRoutines();
      await t.repository.applyRemoteProgram([
        { id: 'active', programId: 'duplo', updatedAt: 10, clientUpdatedAt: 100 },
      ]);
      expect(await t.repository.activeProgramId()).toBe('duplo');

      await t.repository.applyRemoteProgram([
        { id: 'active', programId: 'outro', updatedAt: 20, clientUpdatedAt: 50 },
      ]);
      expect(await t.repository.activeProgramId()).toBe('duplo');

      await t.repository.applyRemoteProgram([
        { id: 'active', programId: 'outro', updatedAt: 30, clientUpdatedAt: 200 },
      ]);
      expect(await t.repository.activeProgramId()).toBe('outro');
    });

    describe('in two tabs at the same time', () => {
      afterEach(removeLocks);

      /** Uma segunda aba: outra conexão ao MESMO banco do aparelho e outro repositório (a fila e os modelos são os mesmos). */
      function openOtherTab(factory: IDBFactory, db: TrainingDb) {
        const otherDb = new TrainingDb(db.name, {
          indexedDB: factory,
          IDBKeyRange: FakeIDBKeyRange,
        });
        const injector = Injector.create({
          providers: [{ provide: TRAINING_DB, useValue: otherDb }],
          parent: TestBed.inject(Injector),
        });
        return {
          repository: runInInjectionContext(injector, () => new RoutineRepository()),
          db: otherDb,
        };
      }

      async function chooseInBothTabs() {
        const factory = new FakeIDBFactory();
        const t = setupRoutines(createTrainingTestDb(factory));
        withPrograms(t);
        await seedCatalog(t.trainingDb, SLUGS);
        const other = openOtherTab(factory, t.trainingDb);
        try {
          await Promise.all([
            t.repository.selectProgram('duplo'),
            other.repository.selectProgram('duplo'),
          ]);
          const alive = (await t.trainingDb.routines.toArray())
            .filter((row) => row.deletedAt === null && row.programId === 'duplo')
            .sort((a, b) => a.position - b.position);
          return {
            t,
            alive,
            program: await t.repository.activeProgramId(),
            routinePuts: (await t.outbox()).filter((entry) => entry.url.includes('/routines/')),
          };
        } finally {
          other.db.close();
        }
      }

      function expectRoutinesCreatedOnce(done: Awaited<ReturnType<typeof chooseInBothTabs>>) {
        expect(done.alive.map((row) => row.weekdays)).toEqual([[1], [3]]);
        expect(done.alive.every((row) => row.active)).toBe(true);
        expect(done.program).toBe('duplo');
        // Uma ficha, um PUT: a aba que chegou depois não grava as fichas do modelo de novo.
        expect(done.routinePuts).toHaveLength(2);
      }

      it('creates the routines of the program once', async () => {
        expectRoutinesCreatedOnce(await chooseInBothTabs());
      });

      it('serializes the two choices through an exclusive lock named after the account database', async () => {
        const locks = exclusiveLocks();
        installLocks(locks.manager);

        const done = await chooseInBothTabs();

        expectRoutinesCreatedOnce(done);
        expect(locks.requested).toEqual([
          `uniover-training-program:${done.t.trainingDb.name}`,
          `uniover-training-program:${done.t.trainingDb.name}`,
        ]);
      });

      it('still creates them once when the lock lets both tabs in: the check is inside the write', async () => {
        installLocks(grantEverything());

        expectRoutinesCreatedOnce(await chooseInBothTabs());
      });

      it('does not duplicate the routines when a pull brings them while the choice is being built', async () => {
        const t = setupRoutines();
        withPrograms(t);
        await seedCatalog(t.trainingDb, SLUGS);
        const repository = t.repository as unknown as {
          buildRoutines: (...args: unknown[]) => Promise<unknown>;
        };
        const build = repository.buildRoutines.bind(repository);
        vi.spyOn(repository, 'buildRoutines').mockImplementationOnce(async (...args) => {
          const built = await build(...args);
          // Outro aparelho já tinha escolhido este programa: o puxar traz as fichas dele no meio da decisão.
          await t.repository.applyRemote([
            toLocalRoutine(routineDto('remota-a', { programId: 'duplo', weekdays: [1] })),
            toLocalRoutine(routineDto('remota-b', { programId: 'duplo', weekdays: [3] })),
          ]);
          return built;
        });

        const result = await t.repository.selectProgram('duplo');

        if (result.status !== 'saved') throw new Error(result.status);
        expect(result.routines.map((row) => row.id).sort()).toEqual(['remota-a', 'remota-b']);
        expect(
          (await t.repository.listAll()).filter((row) => row.programId === 'duplo'),
        ).toHaveLength(2);
        expect(await t.repository.activeProgramId()).toBe('duplo');
        expect((await t.outbox()).map((entry) => entry.url.replace(/.*\/training\//, ''))).toEqual([
          'program',
        ]);
      });
    });
  });

  describe('templates', () => {
    it('keeps a copy and serves it when the network fails', async () => {
      const t = setupRoutines();
      await seedCatalog(t.trainingDb, ['supino', 'crucifixo', 'rosca', 'triceps']);

      expect((await t.repository.templates()).map((template) => template.id)).toEqual(['duplo']);
      t.api.failing = true;

      expect((await t.repository.templates()).map((template) => template.id)).toEqual(['duplo']);
      const result = await t.repository.createFromTemplate('duplo');
      expect(result.status).toBe('saved');
      expect(t.api.calls).toBe(3);
    });

    it('rejects when there is neither network nor copy, and createFromTemplate says so', async () => {
      const t = setupRoutines();
      t.api.failing = true;

      await expect(t.repository.templates()).rejects.toBeDefined();
      expect(await t.repository.createFromTemplate('duplo')).toEqual({
        status: 'templates-unavailable',
      });
    });
  });

  describe('applyRemote', () => {
    it('a newer remote routine replaces the local one, and an older one does not', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));
      const newer = toLocalRoutine(
        routineDto(created.id, {
          name: 'Do servidor',
          clientUpdatedAt: new Date(created.clientUpdatedAt + 5000).toISOString(),
        }),
      );

      await t.repository.applyRemote([newer]);
      expect((await t.repository.get(created.id))?.name).toBe('Do servidor');

      const older = toLocalRoutine(
        routineDto(created.id, {
          name: 'Velha',
          clientUpdatedAt: new Date(created.clientUpdatedAt - 5000).toISOString(),
        }),
      );
      await t.repository.applyRemote([older]);
      expect((await t.repository.get(created.id))?.name).toBe('Do servidor');
    });

    it('a remote tombstone newer than the local edit deletes it; an older one does not', async () => {
      const t = setupRoutines();
      const created = savedRoutine(await t.repository.save(DRAFT));

      await t.repository.applyRemote([
        toLocalRoutine(
          routineDto(created.id, {
            deleted: true,
            clientUpdatedAt: new Date(created.clientUpdatedAt - 1).toISOString(),
          }),
        ),
      ]);
      expect(await t.repository.get(created.id)).toBeDefined();

      await t.repository.applyRemote([
        toLocalRoutine(
          routineDto(created.id, {
            deleted: true,
            clientUpdatedAt: new Date(created.clientUpdatedAt + 1).toISOString(),
          }),
        ),
      ]);
      expect(await t.repository.get(created.id)).toBeUndefined();
      expect(await t.trainingDb.routines.count()).toBe(1);
    });

    it('a routine that came from the server shows up, and a local one the server does not know stays', async () => {
      const t = setupRoutines();
      const mine = savedRoutine(await t.repository.save(DRAFT));

      await t.repository.applyRemote([toLocalRoutine(routineDto('remota', { name: 'Remota' }))]);

      expect((await t.repository.listAll()).map((row) => row.id).sort()).toEqual(
        [mine.id, 'remota'].sort(),
      );
    });

    it('does nothing with an empty page', async () => {
      const t = setupRoutines();
      const before = t.repository.revision();

      await t.repository.applyRemote([]);

      expect(t.repository.revision()).toBe(before);
    });
  });
});
