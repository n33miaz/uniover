import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { setupTraining, localExercise } from '../sync/training-test-kit';
import type { TrainingDb } from '../training-db';
import type { RoutineDto, RoutineTemplatesDto } from './routine';
import { RoutineApi } from './routine-api';
import { RoutineRepository } from './routine-repository';

/**
 * Peças de teste das rotinas: o módulo de teste do Treino com os modelos prontos roteirizados e o repositório
 * pronto. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */

/** Modelos prontos falsos: um programa de dois dias, o segundo com uma supersérie. */
export const TEMPLATES_DTO: RoutineTemplatesDto = {
  items: [
    {
      id: 'duplo',
      name: 'Duplo',
      description: 'Dois treinos.',
      routines: [
        {
          name: 'A · Peito',
          weekdays: null,
          items: [
            {
              exerciseSlug: 'supino',
              targetSets: 4,
              repMin: 6,
              repMax: 10,
              restSeconds: 120,
              supersetGroup: null,
            },
            {
              exerciseSlug: 'crucifixo',
              targetSets: '3',
              repMin: 10,
              repMax: 15,
              restSeconds: 60,
              supersetGroup: null,
            },
          ],
        },
        {
          name: 'B · Braços',
          weekdays: null,
          items: [
            {
              exerciseSlug: 'rosca',
              targetSets: 3,
              repMin: 8,
              repMax: 12,
              restSeconds: 60,
              supersetGroup: 1,
            },
            {
              exerciseSlug: 'triceps',
              targetSets: 3,
              repMin: 10,
              repMax: 15,
              restSeconds: 60,
              supersetGroup: 1,
            },
          ],
        },
      ],
    },
  ],
};

/** Leitura dos modelos falsa: devolve o roteiro, ou falha como a rede falharia. */
export class FakeRoutineApi {
  calls = 0;
  failing = false;
  dto: RoutineTemplatesDto = TEMPLATES_DTO;

  templates(): Promise<RoutineTemplatesDto> {
    this.calls++;
    if (this.failing) return Promise.reject(new HttpErrorResponse({ status: 0 }));
    return Promise.resolve(this.dto);
  }
}

/** Monta o TestBed do Treino com a fila falsa, o banco em memória e os modelos prontos roteirizados. */
export function setupRoutines(db?: TrainingDb) {
  const training = setupTraining(db);
  const api = new FakeRoutineApi();
  TestBed.configureTestingModule({ providers: [{ provide: RoutineApi, useValue: api }] });
  // Sem sessão a fila não envia: o teste enxerga o que ficou guardado.
  training.pause();
  return {
    ...training,
    api,
    repository: TestBed.inject(RoutineRepository),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

/** Grava no catálogo local os exercícios de que um modelo precisa (o `id` é o próprio slug, para o teste ler fácil). */
export async function seedCatalog(
  db: ReturnType<typeof setupTraining>['trainingDb'],
  slugs: readonly string[],
  overrides: Partial<Parameters<typeof localExercise>[1]> = {},
): Promise<void> {
  await db.exercises.bulkPut(
    slugs.map((slug) => localExercise(`id-${slug}`, { slug, ...overrides })),
  );
}

/** Resposta da API com valores razoáveis; o teste sobrescreve só o que importa. */
export function routineDto(id: string, overrides: Partial<RoutineDto> = {}): RoutineDto {
  return {
    id,
    name: 'A',
    position: 0,
    active: true,
    programId: null,
    weekdays: [],
    note: null,
    items: [],
    updatedAt: '2026-10-01T10:00:00.0000000+00:00',
    clientUpdatedAt: '2026-10-01T10:00:00.0000000+00:00',
    deleted: false,
    ...overrides,
  };
}
