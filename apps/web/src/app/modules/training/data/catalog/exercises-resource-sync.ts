import { Injectable, inject } from '@angular/core';
import type { ResourceSync } from '../sync/resource-sync';
import { RESOURCE_NAMES } from '../sync/resource-names';
import { EXERCISES_PATH } from './catalog-api';
import { CatalogRepository } from './catalog-repository';
import { ExerciseDto, toLocalExercise } from './exercise';

/** Máximo de linhas por página do servidor (`PullCursor.MaxLimit`). */
const EXERCISES_PAGE_SIZE = 500;

/** O catálogo de exercícios como recurso sincronizável: o servidor entrega, aqui se converte e se funde. */
@Injectable()
export class ExercisesResourceSync implements ResourceSync<ExerciseDto> {
  private readonly repository = inject(CatalogRepository);

  readonly resource = RESOURCE_NAMES.exercises;
  readonly path = EXERCISES_PATH;
  /**
   * O máximo que o servidor aceita: o catálogo inteiro (algumas centenas de linhas) vem numa resposta só, em vez de uma
   * segunda ida ao servidor na primeira passada de um aparelho novo.
   */
  readonly pageSize = EXERCISES_PAGE_SIZE;

  merge(items: readonly ExerciseDto[]): Promise<void> {
    return this.repository.applyRemote(items.map(toLocalExercise));
  }
}
