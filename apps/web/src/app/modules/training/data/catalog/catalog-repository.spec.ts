import { TestBed } from '@angular/core/testing';
import { setupTraining, localExercise } from '../sync/training-test-kit';
import { CatalogRepository } from './catalog-repository';

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

async function seed() {
  const t = setupTraining();
  const repository = TestBed.inject(CatalogRepository);
  await repository.applyRemote([
    localExercise('supino-reto', {
      name: 'Supino reto',
      primaryMuscles: ['chest'],
      equipment: 'barbell',
    }),
    localExercise('supino-inclinado', {
      name: 'Supino inclinado com halteres',
      primaryMuscles: ['chest'],
      secondaryMuscles: ['triceps'],
      equipment: 'dumbbell',
    }),
    localExercise('agachamento', {
      name: 'Agachamento livre',
      primaryMuscles: ['quadriceps', 'glutes'],
      equipment: 'barbell',
    }),
    localExercise('elevacao', {
      name: 'Elevação pélvica',
      primaryMuscles: ['glutes'],
      equipment: 'bodyweight',
      updatedAt: '2026-10-05T10:00:00Z',
      clientUpdatedAt: '2026-10-05T10:00:00Z',
    }),
    localExercise('remada', {
      name: 'Remada curvada',
      primaryMuscles: ['middle_back'],
      equipment: 'barbell',
    }),
    localExercise('rosca', {
      name: 'Rosca direta',
      primaryMuscles: ['biceps'],
      equipment: 'barbell',
    }),
    localExercise('desenvolvimento', {
      name: 'Desenvolvimento militar',
      primaryMuscles: ['shoulders'],
      equipment: 'barbell',
    }),
    localExercise('apagado', {
      name: 'Supino apagado',
      primaryMuscles: ['chest'],
      equipment: 'barbell',
      deleted: true,
    }),
  ]);
  return { ...t, repository };
}

describe('CatalogRepository', () => {
  describe('text search', () => {
    it('finds "Supino reto" by "supino", without accent and without case', async () => {
      const { repository } = await seed();

      expect(names(await repository.search({ text: 'supino' }))).toEqual([
        'Supino inclinado com halteres',
        'Supino reto',
      ]);
      expect(names(await repository.search({ text: 'SUPINO RETO' }))).toEqual(['Supino reto']);
    });

    it('ignores accents on both sides', async () => {
      const { repository } = await seed();

      expect(names(await repository.search({ text: 'elevacao' }))).toEqual(['Elevação pélvica']);
      expect(names(await repository.search({ text: 'pélvica' }))).toEqual(['Elevação pélvica']);
      expect(names(await repository.search({ text: 'ELEVAÇÃO' }))).toEqual(['Elevação pélvica']);
    });

    it('needs every word, in any order', async () => {
      const { repository } = await seed();

      expect(names(await repository.search({ text: 'halteres supino' }))).toEqual([
        'Supino inclinado com halteres',
      ]);
      expect(await repository.search({ text: 'supino agachamento' })).toEqual([]);
    });

    it('treats a blank text as no filter', async () => {
      const { repository } = await seed();
      expect(await repository.search({ text: '   ' })).toHaveLength(7);
    });
  });

  describe('filters', () => {
    it('filters by muscle, by group and by equipment', async () => {
      const { repository } = await seed();

      expect(names(await repository.search({ muscle: 'glutes' }))).toEqual([
        'Agachamento livre',
        'Elevação pélvica',
      ]);
      expect(names(await repository.search({ group: 'legs' }))).toEqual([
        'Agachamento livre',
        'Elevação pélvica',
      ]);
      expect(names(await repository.search({ group: 'back' }))).toEqual(['Remada curvada']);
      expect(names(await repository.search({ equipment: 'dumbbell' }))).toEqual([
        'Supino inclinado com halteres',
      ]);
    });

    it('does not count a secondary muscle as a match', async () => {
      const { repository } = await seed();
      expect(await repository.search({ muscle: 'triceps' })).toEqual([]);
      expect(await repository.search({ group: 'arms' })).toHaveLength(1);
    });

    it('combines text, group, muscle and equipment with "and"', async () => {
      const { repository } = await seed();

      expect(names(await repository.search({ group: 'chest', equipment: 'barbell' }))).toEqual([
        'Supino reto',
      ]);
      expect(
        names(await repository.search({ text: 'supino', group: 'chest', equipment: 'dumbbell' })),
      ).toEqual(['Supino inclinado com halteres']);
      expect(names(await repository.search({ muscle: 'glutes', equipment: 'bodyweight' }))).toEqual(
        ['Elevação pélvica'],
      );
      expect(await repository.search({ muscle: 'biceps', group: 'chest' })).toEqual([]);
      expect(await repository.search({ text: 'rosca', equipment: 'machine' })).toEqual([]);
    });

    it('returns nothing for a group or muscle that does not exist', async () => {
      const { repository } = await seed();
      expect(await repository.search({ group: 'wings' })).toEqual([]);
      expect(await repository.search({ muscle: 'wings' })).toEqual([]);
    });
  });

  describe('order and count', () => {
    it('sorts by name by default and by most recently changed on request', async () => {
      const { repository } = await seed();

      const byName = names(await repository.search());
      expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'pt-BR')));
      expect(byName[0]).toBe('Agachamento livre');

      const recent = await repository.search({ sort: 'recent' });
      expect(recent[0].name).toBe('Elevação pélvica');
    });

    it('sorts without caring for accents or case', async () => {
      const { repository } = await seed();
      await repository.applyRemote([
        localExercise('abdominal', { name: 'Abdominal canivete', primaryMuscles: ['abdominals'] }),
        localExercise('abducao', { name: 'Abdução de quadril', primaryMuscles: ['abductors'] }),
        localExercise('acai', { name: 'Ácaro', primaryMuscles: ['abdominals'] }),
      ]);

      expect(names(await repository.search({ text: 'ab' })).slice(0, 2)).toEqual([
        'Abdominal canivete',
        'Abdução de quadril',
      ]);
      expect((await repository.search())[0].name).toBe('Abdominal canivete');
    });

    it('counts the rows that pass the filters, and never a tombstone', async () => {
      const { repository } = await seed();

      expect(await repository.count()).toBe(7);
      expect(await repository.count({ group: 'chest' })).toBe(2);
      expect(await repository.count({ text: 'supino' })).toBe(2);
      expect(await repository.count({ text: 'apagado' })).toBe(0);
    });
  });

  describe('single exercise and tombstones', () => {
    it('gets a live exercise by id', async () => {
      const { repository } = await seed();
      expect((await repository.get('rosca'))?.name).toBe('Rosca direta');
      expect(await repository.get('nao-existe')).toBeUndefined();
    });

    it('never returns a tombstone, but keeps the row stored', async () => {
      const { repository, trainingDb } = await seed();

      expect(await repository.get('apagado')).toBeUndefined();
      expect(names(await repository.search({ text: 'apagado' }))).toEqual([]);
      expect(await trainingDb.exercises.get('apagado')).toMatchObject({
        deletedAt: expect.any(Number),
      });
    });
  });

  describe('merging what the server sent', () => {
    it('keeps a newer local edit of an own exercise over an older remote copy', async () => {
      const { repository } = await seed();
      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          name: 'Meu exercício',
          clientUpdatedAt: '2026-10-10T10:00:00Z',
        }),
      ]);

      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          name: 'Versão velha',
          clientUpdatedAt: '2026-10-09T10:00:00Z',
        }),
      ]);

      expect((await repository.get('meu'))?.name).toBe('Meu exercício');
    });

    it('takes a newer remote edit over the local one', async () => {
      const { repository } = await seed();
      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          name: 'Antes',
          clientUpdatedAt: '2026-10-09T10:00:00Z',
        }),
      ]);

      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          name: 'Depois',
          clientUpdatedAt: '2026-10-10T10:00:00Z',
        }),
      ]);

      expect((await repository.get('meu'))?.name).toBe('Depois');
    });

    it('a newer tombstone hides the exercise everywhere, and an older one does not', async () => {
      const { repository } = await seed();
      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          name: 'Meu',
          clientUpdatedAt: '2026-10-10T10:00:00Z',
        }),
      ]);

      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          clientUpdatedAt: '2026-10-09T10:00:00Z',
          deleted: true,
        }),
      ]);
      expect(await repository.get('meu')).toBeDefined();

      await repository.applyRemote([
        localExercise('meu', {
          source: 'own',
          clientUpdatedAt: '2026-10-11T10:00:00Z',
          deleted: true,
        }),
      ]);
      expect(await repository.get('meu')).toBeUndefined();
      expect(names(await repository.search({ text: 'meu' }))).toEqual([]);
    });

    it('never deletes a row because a later batch did not mention it', async () => {
      const { repository, trainingDb } = await seed();
      const before = await trainingDb.exercises.count();

      await repository.applyRemote([
        localExercise('novo', { name: 'Exercício novo', primaryMuscles: ['calves'] }),
      ]);

      expect(await trainingDb.exercises.count()).toBe(before + 1);
      expect((await repository.get('supino-reto'))?.name).toBe('Supino reto');
    });

    it('an empty batch writes nothing and does not bump the revision', async () => {
      const { repository } = await seed();
      const revision = repository.revision();
      await repository.applyRemote([]);
      expect(repository.revision()).toBe(revision);
    });

    it('bumps the revision when it writes', async () => {
      const { repository } = await seed();
      const revision = repository.revision();
      await repository.applyRemote([localExercise('x', { name: 'X' })]);
      expect(repository.revision()).toBeGreaterThan(revision);
    });
  });
});
