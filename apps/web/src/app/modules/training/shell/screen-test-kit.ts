import { vi } from 'vitest';
import type { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Routes, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TrainingSync } from '../data/sync/training-sync';
import type { LocalExercise } from '../data/catalog/exercise';
import { localExercise, setupTraining } from '../data/sync/training-test-kit';
import { RoutineRepository } from '../data/routines/routine-repository';
import type { RoutineItemModel } from '../domain/routines/routine-model';
import type { LocalRoutine } from '../data/routines/routine';
import type { LocalSession, LocalSet } from '../data/sessions/session';
import type { TrainingDb } from '../data/training-db';

/**
 * Peças de teste das telas do Treino: o módulo de teste da camada de dados (banco em memória, fila falsa) com o roteador e
 * a primeira passada do servidor já dada (sem isso as telas esperam a passada e nunca mostram o "não encontrado"). Só os
 * testes importam este arquivo; nada daqui entra no bundle do app.
 */
export async function setupScreen(routes: Routes = [], providers: Provider[] = []) {
  const training = setupTraining();
  TestBed.configureTestingModule({ providers: [provideRouter(routes), ...providers] });
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  training.pause();
  await TestBed.inject(TrainingSync).start();
  return { ...training, harness: () => RouterTestingHarness.create() };
}

/** Espera a asserção valer, redesenhando a tela a cada tentativa (as leituras do banco local são assíncronas). */
export async function eventually(
  fixture: Pick<ComponentFixture<unknown>, 'detectChanges'>,
  assertion: () => void,
): Promise<void> {
  await vi.waitFor(
    () => {
      fixture.detectChanges();
      assertion();
    },
    { timeout: 4000, interval: 15 },
  );
}

/** Catálogo de teste: o `id` de cada exercício é o próprio nome curto, para o teste ler fácil. */
export function catalog(): LocalExercise[] {
  return [
    localExercise('supino-reto', {
      slug: 'supino-reto-com-barra',
      name: 'Supino reto com barra',
      primaryMuscles: ['chest'],
      secondaryMuscles: ['triceps', 'shoulders'],
      equipment: 'barbell',
      instructions: ['Deite no banco.', 'Desça a barra.', 'Empurre.', 'Respire.', 'Termine.'],
    }),
    localExercise('supino-inclinado', {
      slug: 'supino-inclinado-com-halteres',
      name: 'Supino inclinado com halteres',
      primaryMuscles: ['chest'],
      equipment: 'dumbbell',
    }),
    localExercise('agachamento', {
      slug: 'agachamento-livre-com-barra',
      name: 'Agachamento livre',
      primaryMuscles: ['quadriceps'],
      equipment: 'barbell',
    }),
    localExercise('elevacao', {
      slug: 'elevacao-lateral-com-halteres',
      name: 'Elevação lateral',
      primaryMuscles: ['shoulders'],
      equipment: 'dumbbell',
    }),
    localExercise('prancha', {
      slug: 'prancha-isometrica',
      name: 'Prancha isométrica',
      primaryMuscles: ['abdominals'],
      equipment: 'bodyweight',
      recordType: 'time',
      instructions: [],
    }),
  ];
}

export function item(
  id: string,
  exerciseId: string,
  position: number,
  overrides: Partial<RoutineItemModel> = {},
): RoutineItemModel {
  return {
    id,
    exerciseId,
    position,
    targetSets: 3,
    repMin: 8,
    repMax: 12,
    restSeconds: 90,
    supersetGroup: null,
    note: '',
    ...overrides,
  };
}

/** Grava uma rotina pelo repositório (o caminho real: banco local e fila). */
export async function saveRoutine(
  name: string,
  items: readonly RoutineItemModel[],
  extra: { active?: boolean } = {},
): Promise<LocalRoutine> {
  const result = await TestBed.inject(RoutineRepository).save({
    name,
    active: extra.active,
    items: items.map(
      ({ id, exerciseId, targetSets, repMin, repMax, restSeconds, supersetGroup }) => ({
        id,
        exerciseId,
        targetSets,
        repMin,
        repMax,
        restSeconds,
        supersetGroup,
      }),
    ),
  });
  if (result.status !== 'saved') throw new Error(`rotina não gravada: ${result.status}`);
  return result.routine;
}

const DAY_MS = 86_400_000;
// Antes do "agora" do relógio falso dos testes (1_760_000_000_000): o gráfico só olha o que já aconteceu.
export const HISTORY_START = 1_750_000_000_000;

/**
 * Grava no banco local treinos já encerrados com séries de trabalho de um exercício: cada entrada é
 * `[dia, carga em kg, repetições]`, e cada dia diferente vira um treino (os dias contam a partir de `HISTORY_START`).
 */
export async function seedHistory(
  db: TrainingDb,
  exerciseId: string,
  entries: readonly (readonly [day: number, weightKg: number, reps: number])[],
): Promise<void> {
  const days = [...new Set(entries.map(([day]) => day))];
  const sessions: LocalSession[] = days.map((day) => {
    const startedAt = HISTORY_START + day * DAY_MS;
    return {
      id: `${exerciseId}-treino-${day}`,
      routineId: null,
      startedAt,
      finishedAt: startedAt + 3_000_000,
      note: '',
      feeling: null,
      deviceId: 'd',
      updatedAt: startedAt,
      clientUpdatedAt: startedAt,
      deletedAt: null,
    };
  });
  const sets: LocalSet[] = entries.map(([day, weightKg, reps], index) => {
    const completedAt = HISTORY_START + day * DAY_MS + (index + 1) * 60_000;
    return {
      id: `${exerciseId}-serie-${index}`,
      sessionId: `${exerciseId}-treino-${day}`,
      exerciseId,
      position: index,
      setType: 'work',
      weightKg,
      reps,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt,
      updatedAt: completedAt,
      clientUpdatedAt: completedAt,
      deletedAt: null,
    };
  });
  await db.sessions.bulkPut(sessions);
  await db.sets.bulkPut(sets);
}
