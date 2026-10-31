import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { setupTraining } from '../sync/training-test-kit';
import type { TrainingDb } from '../training-db';
import type { BodyEntryDto } from './body-entry';
import type { BodyProfileDto } from './body-profile';
import { BodyRepository } from './body-repository';
import { ProfileRepository } from './profile-repository';

/**
 * Peças de teste do corpo: o módulo de teste do Treino com a fila falsa (sem sessão de login, para o teste enxergar o que
 * ficou guardado) e os repositórios prontos. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */
export function setupBody(db?: TrainingDb, extraProviders: Provider[] = []) {
  const training = setupTraining(db);
  // Troca de portas (fotos, entrega) precisa vir antes de qualquer `inject`.
  if (extraProviders.length > 0) TestBed.configureTestingModule({ providers: extraProviders });
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  training.pause();
  return {
    ...training,
    repository: TestBed.inject(BodyRepository),
    profiles: TestBed.inject(ProfileRepository),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

const STAMP = '2026-10-01T10:00:00.0000000+00:00';

/** Resposta da API com valores razoáveis; o teste sobrescreve só o que importa. */
export function bodyEntryDto(id: string, overrides: Partial<BodyEntryDto> = {}): BodyEntryDto {
  return {
    id,
    measuredOn: '2026-10-01',
    weightKg: 82.4,
    bodyFatPct: null,
    fatMethod: null,
    waistCm: null,
    neckCm: null,
    hipCm: null,
    armCm: null,
    thighCm: null,
    chestCm: null,
    abdomenCm: null,
    forearmCm: null,
    calfCm: null,
    armRightCm: null,
    armLeftCm: null,
    forearmRightCm: null,
    forearmLeftCm: null,
    thighRightCm: null,
    thighLeftCm: null,
    calfRightCm: null,
    calfLeftCm: null,
    chestSkinfoldMm: null,
    abdomenSkinfoldMm: null,
    thighSkinfoldMm: null,
    note: null,
    updatedAt: STAMP,
    clientUpdatedAt: STAMP,
    deleted: false,
    ...overrides,
  };
}

export function bodyProfileDto(overrides: Partial<BodyProfileDto> = {}): BodyProfileDto {
  return {
    heightCm: 180,
    birthDate: '1995-06-15',
    sex: 'male',
    activityFactor: 1.55,
    updatedAt: STAMP,
    clientUpdatedAt: STAMP,
    ...overrides,
  };
}
