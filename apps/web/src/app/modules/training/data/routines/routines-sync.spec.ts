import { TestBed } from '@angular/core/testing';
import { TrainingSync } from '../sync/training-sync';
import { RoutineRepository } from './routine-repository';
import { routineDto, setupRoutines } from './routine-data-test-kit';
import { PROGRAM_PATH, ROUTINES_PATH } from './routine-api';

const DRAFT = {
  name: 'A',
  items: [{ exerciseId: 'supino', targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90 }],
};

describe('routines pull, end to end', () => {
  it('pulls the weekly program chosen on another device', async () => {
    const t = setupRoutines();
    t.pull.script = [
      { items: [], nextCursor: null },
      { items: [], nextCursor: null },
      {
        items: [
          {
            programId: 'ppl-superior-inferior',
            updatedAt: '2026-10-20T10:00:00.0000000+00:00',
            clientUpdatedAt: '2026-10-20T09:59:00.0000000+00:00',
          },
        ],
        nextCursor: 'cursor-p',
      },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(PROGRAM_PATH).toBe('/api/v1/training/program');
    expect(await t.trainingDb.syncState.get('program')).toMatchObject({ cursor: 'cursor-p' });
    expect(await TestBed.inject(RoutineRepository).activeProgramId()).toBe('ppl-superior-inferior');
  });

  it('pulls the routines into the local database, with the items inside', async () => {
    const t = setupRoutines();
    t.pull.script = [
      { items: [], nextCursor: null },
      {
        items: [
          routineDto('r1', {
            name: 'A · Peito',
            items: [
              {
                id: 'i1',
                exerciseId: 'supino',
                position: 0,
                targetSets: 4,
                repMin: 6,
                repMax: 10,
                restSeconds: 120,
                supersetGroup: null,
                note: null,
              },
            ],
          }),
          routineDto('r2', { name: 'B', position: 1 }),
        ],
        nextCursor: 'cursor-r',
      },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(t.pull.calls.map((call) => call.path)).toEqual([
      '/api/v1/training/exercises',
      ROUTINES_PATH,
      PROGRAM_PATH,
      '/api/v1/training/sessions',
      '/api/v1/training/sets',
      '/api/v1/training/goals',
      '/api/v1/training/foods',
      '/api/v1/training/meals',
      '/api/v1/training/body/entries',
      '/api/v1/training/body/profile',
      '/api/v1/training/calendar-entries',
    ]);
    expect(ROUTINES_PATH).toBe('/api/v1/training/routines');
    expect(await t.trainingDb.syncState.get('routines')).toMatchObject({ cursor: 'cursor-r' });
    const repository = TestBed.inject(RoutineRepository);
    expect((await repository.list()).map((row) => row.name)).toEqual(['A · Peito', 'B']);
    expect((await repository.get('r1'))?.items[0]).toMatchObject({
      exerciseId: 'supino',
      targetSets: 4,
    });
  });

  it('does not pull while the queue has a routine waiting to be sent', async () => {
    const t = setupRoutines();
    const sync = TestBed.inject(TrainingSync);
    await sync.start();
    await TestBed.inject(RoutineRepository).save(DRAFT);
    const calls = t.pull.calls.length;

    await sync.pullNow();

    expect(t.pull.calls).toHaveLength(calls);
    expect(t.queue().pendingCount()).toBe(1);
  });

  it('keeps a routine written offline when the pull does not know about it, and a tombstone removes the right one', async () => {
    const t = setupRoutines();
    const sync = TestBed.inject(TrainingSync);
    const repository = TestBed.inject(RoutineRepository);
    await sync.start();
    const saved = await repository.save(DRAFT);
    if (saved.status !== 'saved') throw new Error(saved.status);

    t.resume();
    await t.queue().syncNow();
    t.pull.script = [
      { items: [], nextCursor: null },
      { items: [routineDto('so-no-servidor', { name: 'Do servidor' })], nextCursor: 'c1' },
    ];
    await sync.pullNow();

    expect((await repository.listAll()).map((row) => row.name).sort()).toEqual([
      'A',
      'Do servidor',
    ]);

    t.pull.script = [
      { items: [], nextCursor: null },
      {
        items: [
          routineDto('so-no-servidor', {
            deleted: true,
            clientUpdatedAt: '2026-12-01T10:00:00.0000000+00:00',
            updatedAt: '2026-12-01T10:00:00.0000000+00:00',
          }),
        ],
        nextCursor: 'c2',
      },
    ];
    await sync.pullNow();

    expect((await repository.listAll()).map((row) => row.name)).toEqual(['A']);
  });
});
