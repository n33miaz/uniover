import { TestBed } from '@angular/core/testing';
import { localExercise, setupTraining } from '../sync/training-test-kit';
import { RestAlert } from '../session-live/rest-alert';
import { RestTimerService } from '../session-live/rest-timer.service';
import { WakeLockService } from '../session-live/wake-lock.service';
import type { TrainingDb } from '../training-db';
import type { SessionDto, SetDto } from './session';
import { SessionRepository } from './session-repository';

/**
 * Peças de teste do treino ao vivo: o módulo de teste do Treino com a fila falsa (sem sessão de login, para o teste
 * enxergar o que ficou guardado) e o repositório pronto. Só os testes importam este arquivo; nada daqui entra no bundle.
 */

/** Aviso falso: conta quantas vezes apitou e se o áudio foi liberado. */
export class FakeRestAlert {
  fired = 0;
  unlockCalls = 0;

  unlock(): void {
    this.unlockCalls++;
  }

  fire(): void {
    this.fired++;
  }
}

/** Monta o TestBed do Treino com a fila falsa, o banco em memória e o aviso do descanso falso. */
export function setupSessions(db?: TrainingDb) {
  const training = setupTraining(db);
  const alert = new FakeRestAlert();
  TestBed.configureTestingModule({ providers: [{ provide: RestAlert, useValue: alert }] });
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  training.pause();
  return {
    ...training,
    alert,
    repository: TestBed.inject(SessionRepository),
    timer: () => TestBed.inject(RestTimerService),
    wakeLock: () => TestBed.inject(WakeLockService),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

/** Grava no catálogo local exercícios de peso e repetições, de repetições e de tempo (o `id` é o próprio nome). */
export async function seedExercises(
  db: ReturnType<typeof setupTraining>['trainingDb'],
): Promise<void> {
  await db.exercises.bulkPut([
    localExercise('supino', { recordType: 'weight_reps' }),
    localExercise('agacha', { recordType: 'weight_reps' }),
    localExercise('flexao', { recordType: 'reps_only' }),
    localExercise('prancha', { recordType: 'time' }),
  ]);
}

const STAMP = '2026-10-01T10:00:00.0000000+00:00';

/** Resposta da API com valores razoáveis; o teste sobrescreve só o que importa. */
export function sessionDto(id: string, overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id,
    routineId: null,
    startedAt: STAMP,
    finishedAt: null,
    note: null,
    feeling: null,
    deviceId: 'outro-aparelho',
    updatedAt: STAMP,
    clientUpdatedAt: STAMP,
    deleted: false,
    ...overrides,
  };
}

export function setDto(id: string, sessionId: string, overrides: Partial<SetDto> = {}): SetDto {
  return {
    id,
    sessionId,
    exerciseId: 'supino',
    position: 0,
    setType: 'work',
    weightKg: 80,
    reps: 8,
    durationS: null,
    rir: null,
    rpe: null,
    note: null,
    completedAt: STAMP,
    updatedAt: STAMP,
    clientUpdatedAt: STAMP,
    deleted: false,
    ...overrides,
  };
}
