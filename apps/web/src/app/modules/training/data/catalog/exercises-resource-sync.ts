import { Injectable, inject } from '@angular/core';
import type { ResourceSync } from '../sync/resource-sync';
import { EXERCISES_PATH } from './catalog-api';
import { CatalogRepository } from './catalog-repository';
import { ExerciseDto, toLocalExercise } from './exercise';

/** O catálogo de exercícios como recurso sincronizável: o servidor entrega, aqui se converte e se funde. */
@Injectable()
export class ExercisesResourceSync implements ResourceSync<ExerciseDto> {
  private readonly repository = inject(CatalogRepository);

  readonly resource = 'exercises';
  readonly path = EXERCISES_PATH;

  merge(items: readonly ExerciseDto[]): Promise<void> {
    return this.repository.applyRemote(items.map(toLocalExercise));
  }
}
