import { TestBed } from '@angular/core/testing';
import { at } from '../../domain/progress/progress-test-kit';
import { localExercise, setupTraining } from '../sync/training-test-kit';
import type { LocalSession, LocalSet } from '../sessions/session';
import type { TrainingDb } from '../training-db';
import { ProgressRepository } from './progress-repository';

/**
 * Peças de teste do progresso: o módulo de teste do Treino (fila pausada) com o repositório de leitura pronto e atalhos para
 * gravar treinos e séries direto no banco. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */
export function setupProgress(db?: TrainingDb) {
  const training = setupTraining(db);
  training.pause();
  return {
    ...training,
    repository: TestBed.inject(ProgressRepository),
    outbox: () => training.db.outbox.toArray(),
  };
}

type Db = ReturnType<typeof setupProgress>['trainingDb'];

/** Exercícios do caso de referência: peito, costas, pernas, ombros, tríceps e bíceps (`id` = nome curto). */
export async function seedExerciseCatalog(db: Db): Promise<void> {
  await db.exercises.bulkPut([
    localExercise('supino', {
      name: 'Supino reto',
      primaryMuscles: ['chest', 'triceps'],
      equipment: 'barbell',
    }),
    localExercise('remada', {
      name: 'Remada curvada',
      primaryMuscles: ['lats'],
      equipment: 'barbell',
    }),
    localExercise('agacha', {
      name: 'Agachamento',
      primaryMuscles: ['quadriceps'],
      equipment: 'barbell',
    }),
    localExercise('militar', {
      name: 'Desenvolvimento',
      primaryMuscles: ['shoulders'],
      equipment: 'dumbbell',
    }),
    localExercise('triceps', {
      name: 'Tríceps na polia',
      primaryMuscles: ['triceps'],
      equipment: 'cable',
    }),
    localExercise('rosca', {
      name: 'Rosca direta',
      primaryMuscles: ['biceps'],
      equipment: 'barbell',
    }),
  ]);
}

export function session(
  id: string,
  day: string,
  overrides: Partial<LocalSession> = {},
): LocalSession {
  const startedAt = at(day, 8);
  return {
    id,
    routineId: null,
    startedAt,
    finishedAt: startedAt + 3_600_000,
    note: '',
    feeling: null,
    deviceId: 'este-aparelho',
    updatedAt: startedAt,
    clientUpdatedAt: startedAt,
    deletedAt: null,
    ...overrides,
  };
}

export function localSet(
  id: string,
  sessionId: string,
  overrides: Partial<LocalSet> = {},
): LocalSet {
  return {
    id,
    sessionId,
    exerciseId: 'supino',
    position: 0,
    setType: 'work',
    weightKg: 40,
    reps: 10,
    durationS: null,
    rir: null,
    rpe: null,
    note: '',
    completedAt: at('2026-10-10', 9),
    updatedAt: 1,
    clientUpdatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

/** `count` séries do exercício na sessão, uma por minuto a partir de `day` e `hour`. */
export function sets(
  prefix: string,
  sessionId: string,
  exerciseId: string,
  count: number,
  day: string,
  overrides: Partial<LocalSet> = {},
  hour = 9,
): LocalSet[] {
  return Array.from({ length: count }, (_, index) =>
    localSet(`${prefix}-${index}`, sessionId, {
      exerciseId,
      position: index,
      completedAt: at(day, hour, index),
      ...overrides,
    }),
  );
}
