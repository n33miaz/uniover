import { TestBed } from '@angular/core/testing';
import { TrainingSync } from '../sync/training-sync';
import { GOALS_PATH, goalPath } from './goal-api';
import { GoalRepository } from './goal-repository';
import { goalDto, setupGoals } from './goal-data-test-kit';

const EMPTY = { items: [], nextCursor: null };

describe('goals pull, end to end', () => {
  it('pulls the goals after the sessions and the sets, and keeps them in the local database', async () => {
    const t = setupGoals();
    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      {
        items: [
          goalDto('weekly_sessions', { value: 3 }),
          goalDto('exercise_e1rm', { exerciseId: 'supino', value: '55.00' }),
          goalDto('daily_kcal', { value: null, deleted: true }),
          goalDto('body_fat', { value: 12 }),
        ],
        nextCursor: 'cursor-g',
      },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(t.pull.calls.map((call) => call.path)).toEqual([
      '/api/v1/training/exercises',
      '/api/v1/training/routines',
      '/api/v1/training/sessions',
      '/api/v1/training/sets',
      GOALS_PATH,
    ]);
    expect(GOALS_PATH).toBe('/api/v1/training/goals');
    expect(goalPath('weekly_sessions')).toBe('/api/v1/training/goals/weekly_sessions');
    expect(await t.trainingDb.syncState.get('goals')).toMatchObject({ cursor: 'cursor-g' });

    const repository = TestBed.inject(GoalRepository);
    expect(await repository.value('weekly_sessions')).toBe(3);
    expect(await repository.value('exercise_e1rm', 'supino')).toBe(55);
    expect(await repository.get('daily_kcal')).toBeUndefined();
    // A meta de um tipo desconhecido não entra, e a lápide fica na linha.
    expect(await t.trainingDb.goals.count()).toBe(3);
    expect(await t.trainingDb.goals.get('daily_kcal:')).toMatchObject({ value: null });
  });

  it('a later pull reapplies the window without duplicating the goal', async () => {
    const t = setupGoals();
    const sync = TestBed.inject(TrainingSync);
    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      { items: [goalDto('weekly_sessions', { value: 3 })], nextCursor: 'c1' },
    ];
    await sync.start();

    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      {
        items: [
          goalDto('weekly_sessions', {
            value: 4,
            clientUpdatedAt: '2026-10-02T10:00:00Z',
            updatedAt: '2026-10-02T10:00:00Z',
          }),
        ],
        nextCursor: 'c2',
      },
    ];
    await sync.pullNow();

    const repository = TestBed.inject(GoalRepository);
    expect(await t.trainingDb.goals.count()).toBe(1);
    expect(await repository.value('weekly_sessions')).toBe(4);
  });
});
