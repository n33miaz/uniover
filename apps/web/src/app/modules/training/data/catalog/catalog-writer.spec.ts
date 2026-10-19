import { TestBed } from '@angular/core/testing';
import { isUuid } from '../../../../core/offline-queue/uuid-v7';
import { networkError } from '../../../../core/offline-queue/queue-test-kit';
import { localExercise, setupTraining } from '../sync/training-test-kit';
import { CatalogRepository } from './catalog-repository';
import { CatalogWriter, CustomExerciseDraft } from './catalog-writer';

const DRAFT: CustomExerciseDraft = {
  name: '  Remada na polia  ',
  primaryMuscles: ['middle_back', 'lats'],
  secondaryMuscles: ['biceps'],
  equipment: 'cable',
  recordType: 'weight_reps',
  instructions: ['Puxe até o abdômen.', '  ', 'Volte devagar.'],
};

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

function setup() {
  const t = setupTraining();
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  t.pause();
  return {
    ...t,
    writer: TestBed.inject(CatalogWriter),
    repository: TestBed.inject(CatalogRepository),
    outbox: () => t.db.outbox.orderBy('createdAt').toArray(),
  };
}

describe('CatalogWriter', () => {
  describe('saveCustomExercise', () => {
    it('writes to the device first and queues exactly one PUT with a UUID v7 id', async () => {
      const t = setup();

      const result = await t.writer.saveCustomExercise(DRAFT);

      expect(result.status).toBe('saved');
      const exercise = (result as { exercise: { id: string } }).exercise;
      expect(isUuid(exercise.id)).toBe(true);
      expect(exercise.id[14]).toBe('7');

      const stored = await t.repository.get(exercise.id);
      expect(stored).toMatchObject({
        source: 'own',
        name: 'Remada na polia',
        nameKey: 'remada na polia',
        primaryMuscles: ['middle_back', 'lats'],
        secondaryMuscles: ['biceps'],
        equipment: 'cable',
        recordType: 'weight_reps',
        instructions: ['Puxe até o abdômen.', 'Volte devagar.'],
        stepKg: null,
        deletedAt: null,
        reviewed: true,
      });

      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: `/api/v1/training/exercises/${exercise.id}`,
        module: 'training',
        status: 'pending',
        attempts: 0,
      });
      expect(queued[0].body).toEqual({
        name: 'Remada na polia',
        primaryMuscles: ['middle_back', 'lats'],
        secondaryMuscles: ['biceps'],
        equipment: 'cable',
        recordType: 'weight_reps',
        stepKg: null,
        instructions: ['Puxe até o abdômen.', 'Volte devagar.'],
        clientUpdatedAt: new Date(t.runtime.now()).toISOString(),
        deleted: false,
      });
      expect(t.queue().pendingCount()).toBe(1);
    });

    it('is found by the search right after saving, with no network', async () => {
      const t = setup();
      await t.writer.saveCustomExercise(DRAFT);
      expect((await t.repository.search({ text: 'REMADA polia' })).map((row) => row.name)).toEqual([
        'Remada na polia',
      ]);
    });

    it('reuses the same idempotency key on every attempt of the same item', async () => {
      const t = setup();
      t.transport.script = [networkError()];
      await t.writer.saveCustomExercise(DRAFT);
      const [item] = await t.outbox();

      t.resume();
      await t.queue().syncNow();
      await t.queue().syncNow();

      expect(t.transport.requests).toHaveLength(2);
      expect(t.transport.keys).toEqual([item.id, item.id]);
      expect(t.transport.requests.every((r) => r.url === item.url && r.method === 'PUT')).toBe(
        true,
      );
      expect(await t.outbox()).toEqual([]);
    });

    it('editing keeps the id, moves the clock forward and queues the PUT again', async () => {
      const t = setup();
      const created = await t.writer.saveCustomExercise(DRAFT);
      const { exercise } = created as { exercise: { id: string; clientUpdatedAt: number } };

      const edited = await t.writer.saveCustomExercise({
        ...DRAFT,
        id: exercise.id,
        name: 'Remada baixa',
      });

      expect(edited.status).toBe('saved');
      const stored = await t.repository.get(exercise.id);
      expect(stored?.name).toBe('Remada baixa');
      expect(stored?.clientUpdatedAt).toBeGreaterThan(exercise.clientUpdatedAt);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued.every((item) => item.url.endsWith(exercise.id))).toBe(true);
      expect((queued[1].body as { name: string }).name).toBe('Remada baixa');
    });

    it('keeps an owner step choice when the exercise is edited', async () => {
      const t = setup();
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string };
      };
      await t.writer.setStepKg(exercise.id, 1.25);

      await t.writer.saveCustomExercise({ ...DRAFT, id: exercise.id, stepKg: 10, name: 'Outra' });

      expect((await t.repository.get(exercise.id))?.stepKg).toBe(1.25);
    });

    it('refuses an invalid draft before touching the device or the queue', async () => {
      const t = setup();

      await expect(t.writer.saveCustomExercise({ ...DRAFT, name: '   ' })).rejects.toThrow(
        TypeError,
      );
      await expect(
        t.writer.saveCustomExercise({ ...DRAFT, name: 'x'.repeat(121) }),
      ).rejects.toThrow(TypeError);
      await expect(t.writer.saveCustomExercise({ ...DRAFT, primaryMuscles: [] })).rejects.toThrow(
        TypeError,
      );
      await expect(
        t.writer.saveCustomExercise({
          ...DRAFT,
          primaryMuscles: ['chest', 'lats', 'traps', 'neck'],
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        t.writer.saveCustomExercise({
          ...DRAFT,
          instructions: Array.from({ length: 21 }, () => 'passo'),
        }),
      ).rejects.toThrow(TypeError);

      expect(await t.trainingDb.exercises.count()).toBe(0);
      expect(await t.outbox()).toEqual([]);
    });

    it('does not edit a catalog exercise or a missing one', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo', { name: 'Supino' })]);

      expect((await t.writer.saveCustomExercise({ ...DRAFT, id: 'catalogo' })).status).toBe(
        'catalog-readonly',
      );
      expect((await t.writer.saveCustomExercise({ ...DRAFT, id: 'inexistente' })).status).toBe(
        'not-found',
      );
      expect(await t.outbox()).toEqual([]);
      expect((await t.repository.get('catalogo'))?.name).toBe('Supino');
    });
  });

  describe('when the device has no space for the queue item', () => {
    it('undoes the local write of a new exercise and says so', async () => {
      const t = setup();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.writer.saveCustomExercise(DRAFT);

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.trainingDb.exercises.count()).toBe(0);
      expect(await t.repository.search()).toEqual([]);
      expect(t.queue().pendingCount()).toBe(0);
    });

    it('puts the previous version back when an edit cannot be queued', async () => {
      const t = setup();
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string };
      };
      const before = await t.trainingDb.exercises.get(exercise.id);
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      const result = await t.writer.saveCustomExercise({
        ...DRAFT,
        id: exercise.id,
        name: 'Nunca gravada',
      });

      expect(result).toEqual({ status: 'storage-full' });
      expect(await t.trainingDb.exercises.get(exercise.id)).toEqual(before);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('puts the previous step back when the step change cannot be queued', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo', { equipment: 'barbell' })]);
      const before = await t.trainingDb.exercises.get('catalogo');
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.writer.setStepKg('catalogo', 1)).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.exercises.get('catalogo')).toEqual(before);
    });

    it('brings a deleted exercise back when the tombstone cannot be queued', async () => {
      const t = setup();
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string };
      };
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.writer.deleteCustomExercise(exercise.id)).toEqual({ status: 'storage-full' });

      expect(await t.repository.get(exercise.id)).toBeDefined();
    });

    it('does not undo a row that something else changed in the meantime', async () => {
      const t = setup();
      const changeThenFail = async () => {
        const [row] = await t.trainingDb.exercises.toArray();
        await t.repository.writeLocal({
          ...row,
          name: 'Mudou no meio',
          clientUpdatedAt: row.clientUpdatedAt + 5,
        });
        throw quota();
      };
      vi.spyOn(t.db.outbox, 'add').mockImplementation(changeThenFail as never);

      expect(await t.writer.saveCustomExercise(DRAFT)).toEqual({ status: 'storage-full' });

      const [row] = await t.trainingDb.exercises.toArray();
      expect(row.name).toBe('Mudou no meio');
    });

    it('rethrows any other failure, after undoing the local write', async () => {
      const t = setup();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(new Error('outro erro'));

      await expect(t.writer.saveCustomExercise(DRAFT)).rejects.toThrow('outro erro');
      expect(await t.trainingDb.exercises.count()).toBe(0);
    });
  });

  describe('deleteCustomExercise', () => {
    it('leaves a tombstone locally and queues a PUT with deleted true, never a DELETE', async () => {
      const t = setup();
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string };
      };

      const result = await t.writer.deleteCustomExercise(exercise.id);

      expect(result.status).toBe('saved');
      expect(await t.repository.get(exercise.id)).toBeUndefined();
      expect(await t.trainingDb.exercises.get(exercise.id)).toMatchObject({
        deletedAt: expect.any(Number),
      });
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued.map((item) => item.method)).toEqual(['PUT', 'PUT']);
      expect(queued[1].body).toMatchObject({ deleted: true, name: 'Remada na polia' });
    });

    it('does not delete a catalog exercise, a missing one or one already deleted', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo')]);
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string };
      };
      await t.writer.deleteCustomExercise(exercise.id);
      const queued = (await t.outbox()).length;

      expect((await t.writer.deleteCustomExercise('catalogo')).status).toBe('catalog-readonly');
      expect((await t.writer.deleteCustomExercise('inexistente')).status).toBe('not-found');
      expect((await t.writer.deleteCustomExercise(exercise.id)).status).toBe('not-found');
      expect(await t.outbox()).toHaveLength(queued);
    });
  });

  describe('setStepKg', () => {
    it('saves the choice locally with its own clock and queues the step PUT', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo', { equipment: 'barbell' })]);

      const result = await t.writer.setStepKg('catalogo', 1.25);

      expect(result.status).toBe('saved');
      const stored = await t.repository.get('catalogo');
      expect(stored?.stepKg).toBe(1.25);
      expect(stored?.stepClientUpdatedAt).toBe(t.runtime.now());
      const [item] = await t.outbox();
      expect(item).toMatchObject({
        method: 'PUT',
        url: '/api/v1/training/exercises/catalogo/step',
        module: 'training',
      });
      expect(item.body).toEqual({
        stepKg: 1.25,
        clientUpdatedAt: new Date(t.runtime.now()).toISOString(),
      });
    });

    it('null gives the step back to the equipment, still as an explicit choice', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo')]);
      await t.writer.setStepKg('catalogo', 1.25);
      const first = (await t.repository.get('catalogo'))?.stepClientUpdatedAt as number;

      await t.writer.setStepKg('catalogo', null);

      const stored = await t.repository.get('catalogo');
      expect(stored?.stepKg).toBeNull();
      expect(stored?.stepClientUpdatedAt).toBeGreaterThan(first);
      expect((await t.outbox())[1].body).toMatchObject({ stepKg: null });
    });

    it('also works on an own exercise and leaves its content clock alone', async () => {
      const t = setup();
      const { exercise } = (await t.writer.saveCustomExercise(DRAFT)) as {
        exercise: { id: string; clientUpdatedAt: number };
      };

      await t.writer.setStepKg(exercise.id, 2);

      expect((await t.repository.get(exercise.id))?.clientUpdatedAt).toBe(exercise.clientUpdatedAt);
    });

    it('refuses a missing exercise and an invalid step', async () => {
      const t = setup();
      await t.repository.applyRemote([localExercise('catalogo')]);

      expect((await t.writer.setStepKg('inexistente', 2)).status).toBe('not-found');
      await expect(t.writer.setStepKg('catalogo', -1)).rejects.toThrow(TypeError);
      await expect(t.writer.setStepKg('catalogo', Number.NaN)).rejects.toThrow(TypeError);
      expect(await t.outbox()).toEqual([]);
    });
  });
});
