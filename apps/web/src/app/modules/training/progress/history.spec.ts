import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { LocalSet } from '../data/sessions/session';
import { seedHistory } from '../shell/screen-test-kit';
import { summarizeHistory } from './history';
import { setupProgress } from './progress-test-kit';

type SetRow = Pick<LocalSet, 'exerciseId' | 'setType' | 'weightKg' | 'reps' | 'completedAt'>;

const set = (overrides: Partial<SetRow> = {}): SetRow => ({
  exerciseId: 'supino',
  setType: 'work',
  weightKg: 40,
  reps: 10,
  completedAt: 100,
  ...overrides,
});

describe('summarizeHistory', () => {
  const sessions = [
    { id: 'a', startedAt: 10 },
    { id: 'b', startedAt: 20 },
    { id: 'c', startedAt: 30 },
  ];

  it('lists the exercises with a load, the most recently trained first, and counts only real trainings', () => {
    const sets: Record<string, SetRow[]> = {
      // Só aquecimento: não é treino, e o exercício dele não ganha histórico.
      a: [set({ exerciseId: 'elevacao', setType: 'warmup', completedAt: 11 })],
      b: [
        set({ exerciseId: 'supino', completedAt: 21 }),
        set({ exerciseId: 'agachamento', weightKg: 60, reps: 8, completedAt: 22 }),
        // Prancha: série de tempo, sem carga nem repetições: não dá gráfico de carga.
        set({ exerciseId: 'prancha', weightKg: null, reps: null, completedAt: 23 }),
      ],
      c: [
        set({ exerciseId: 'supino', weightKg: 42.5, reps: 8, completedAt: 31 }),
        set({ exerciseId: 'elevacao', setType: 'warmup', completedAt: 32 }),
      ],
    };
    const history = summarizeHistory(sessions, (id) => sets[id] ?? []);

    expect(history.exercises).toEqual([
      { id: 'supino', lastAt: 31 },
      { id: 'agachamento', lastAt: 22 },
    ]);
    expect(history.sessions).toEqual([{ startedAt: 20 }, { startedAt: 30 }]);
  });

  it('is empty without trainings', () => {
    expect(summarizeHistory([], () => [])).toEqual({ exercises: [], sessions: [] });
  });

  it('counts a training with a drop set or a failure set as a training and keeps the load', () => {
    const history = summarizeHistory([{ id: 'a', startedAt: 1 }], () => [
      set({ setType: 'failure', completedAt: 5 }),
      set({ setType: 'drop', weightKg: 30, completedAt: 6 }),
    ]);
    expect(history.exercises).toEqual([{ id: 'supino', lastAt: 6 }]);
    expect(history.sessions).toHaveLength(1);
  });
});

describe('ProgressHistory', () => {
  it('reads the trainings from the local database, without waiting for the network', async () => {
    const kit = await setupProgress();
    await seedHistory(kit.trainingDb, 'supino-reto', [[100, 40, 10]]);
    const history = kit.history();
    expect(history.data()).toBeNull();

    await vi.waitFor(() => {
      TestBed.tick();
      expect(history.data()).not.toBeNull();
    });
    expect(history.data()!.exercises.map((exercise) => exercise.id)).toEqual(['supino-reto']);
    expect(history.data()!.sessions).toHaveLength(1);
  });
});
