import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { CatalogRepository } from './catalog/catalog-repository';
import { CatalogStore } from './catalog/catalog-store';
import { CatalogWriter } from './catalog/catalog-writer';
import { ExercisesResourceSync } from './catalog/exercises-resource-sync';
import { TRAINING_RESOURCE_SYNCS } from './sync/resource-sync';
import { TrainingSync } from './sync/training-sync';
import { exerciseDto, setupTraining } from './sync/training-test-kit';

describe('provideTrainingData', () => {
  it('registers the sync, the catalog access classes and one resource per line', () => {
    setupTraining();

    expect(TestBed.inject(TrainingSync)).toBeInstanceOf(TrainingSync);
    expect(TestBed.inject(CatalogRepository)).toBeInstanceOf(CatalogRepository);
    expect(TestBed.inject(CatalogStore)).toBeInstanceOf(CatalogStore);
    expect(TestBed.inject(CatalogWriter)).toBeInstanceOf(CatalogWriter);

    const resources = TestBed.inject(TRAINING_RESOURCE_SYNCS);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toBeInstanceOf(ExercisesResourceSync);
    expect(resources[0]).toMatchObject({
      resource: 'exercises',
      path: '/api/v1/training/exercises',
    });
  });
});

describe('catalog pull, end to end', () => {
  // 200 é o tamanho de página padrão: duas páginas de verdade, a segunda incompleta.
  const firstPage = Array.from({ length: 200 }, (_, i) =>
    exerciseDto(`ex-${String(i).padStart(3, '0')}`, {
      name: `Exercício ${i}`,
      updatedAt: `2026-10-01T10:00:${String(i % 60).padStart(2, '0')}Z`,
    }),
  );
  const secondPage = [
    exerciseDto('supino', { name: 'Supino reto', stepKg: '2.5' }),
    exerciseDto('agacha', { name: 'Agachamento livre', primaryMuscles: ['quadriceps'] }),
    exerciseDto('apagado', { name: 'Exercício apagado', deleted: true }),
  ];

  it('pulls two pages into the local database and makes the catalog searchable offline', async () => {
    const t = setupTraining();
    t.pull.script = [
      { items: firstPage, nextCursor: 'cursor-1' },
      { items: secondPage, nextCursor: 'cursor-2' },
    ];
    const repository = TestBed.inject(CatalogRepository);

    await TestBed.inject(TrainingSync).start();

    expect(t.pull.calls).toEqual([
      { path: '/api/v1/training/exercises', after: null, limit: 200 },
      { path: '/api/v1/training/exercises', after: 'cursor-1', limit: 200 },
    ]);
    expect(await t.trainingDb.exercises.count()).toBe(203);
    expect(await t.trainingDb.syncState.get('exercises')).toMatchObject({ cursor: 'cursor-2' });

    // Já sem rede: a busca lê só do aparelho, e a lápide não aparece.
    expect((await repository.search({ text: 'SUPINO' })).map((row) => row.name)).toEqual([
      'Supino reto',
    ]);
    expect((await repository.get('supino'))?.stepKg).toBe(2.5);
    expect(await repository.get('apagado')).toBeUndefined();
    expect(await repository.count()).toBe(202);
  });

  it('a later pull reapplies the window without duplicating, and never deletes by absence', async () => {
    const t = setupTraining();
    t.pull.script = [{ items: secondPage, nextCursor: 'cursor-2' }];
    const sync = TestBed.inject(TrainingSync);
    const repository = TestBed.inject(CatalogRepository);
    await sync.start();

    // O servidor só devolve o que mudou: uma linha nova e a repetição de uma que já estava.
    t.pull.script = [
      {
        items: [
          secondPage[0],
          exerciseDto('rosca', { name: 'Rosca direta', primaryMuscles: ['biceps'] }),
        ],
        nextCursor: 'cursor-3',
      },
    ];
    await sync.pullNow();

    expect(await t.trainingDb.exercises.count()).toBe(4);
    expect((await repository.get('agacha'))?.name).toBe('Agachamento livre');
    expect((await repository.get('rosca'))?.name).toBe('Rosca direta');
  });

  it('keeps what was written offline when the pull does not know about it', async () => {
    const t = setupTraining();
    t.pause();
    const sync = TestBed.inject(TrainingSync);
    const writer = TestBed.inject(CatalogWriter);
    const repository = TestBed.inject(CatalogRepository);
    await sync.start();

    const saved = await writer.saveCustomExercise({
      name: 'Meu exercício',
      primaryMuscles: ['chest'],
      equipment: 'other',
      recordType: 'reps_only',
    });
    expect(saved.status).toBe('saved');

    // A fila ainda tem o pedido: nada é puxado. Mesmo que fosse, a fusão não apaga linha por ausência.
    const callsBefore = t.pull.calls.length;
    await sync.pullNow();
    expect(t.pull.calls).toHaveLength(callsBefore);

    t.resume();
    await t.queue().syncNow();
    t.pull.script = [{ items: secondPage, nextCursor: 'cursor-2' }];
    await sync.pullNow();

    expect((await repository.search({ text: 'meu exercicio' })).map((row) => row.name)).toEqual([
      'Meu exercício',
    ]);
    expect(t.pull.calls.length).toBeGreaterThan(callsBefore);
  });

  it('keeps the catalog usable when the network fails, and says so in the signal', async () => {
    const t = setupTraining();
    t.pull.script = [{ items: secondPage, nextCursor: 'cursor-2' }];
    const sync = TestBed.inject(TrainingSync);
    const repository = TestBed.inject(CatalogRepository);
    await sync.start();
    const lastPullAt = sync.lastPullAt();
    t.runtime.advance(60_000);

    t.pull.script = [new HttpErrorResponse({ status: 0 })];
    await sync.pullNow();

    expect(sync.error()).toBe('network');
    expect(sync.lastPullAt()).toBe(lastPullAt);
    expect(await repository.count()).toBe(2);
  });
});
