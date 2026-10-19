import { TestBed } from '@angular/core/testing';
import { setupTraining } from '../sync/training-test-kit';
import type { TrainingDb } from '../training-db';
import type { GoalDto } from './goal';
import { GoalRepository } from './goal-repository';

/**
 * Peças de teste das metas: o módulo de teste do Treino com a fila falsa (sem sessão de login, para o teste enxergar o que
 * ficou guardado) e o repositório pronto. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */
export function setupGoals(db?: TrainingDb) {
  const training = setupTraining(db);
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  training.pause();
  return {
    ...training,
    repository: TestBed.inject(GoalRepository),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

const STAMP = '2026-10-01T10:00:00.0000000+00:00';

/** Resposta da API com valores razoáveis; o teste sobrescreve só o que importa. */
export function goalDto(kind: string, overrides: Partial<GoalDto> = {}): GoalDto {
  return {
    id: `servidor-${kind}`,
    kind,
    exerciseId: null,
    value: 3,
    updatedAt: STAMP,
    clientUpdatedAt: STAMP,
    deleted: false,
    ...overrides,
  };
}
