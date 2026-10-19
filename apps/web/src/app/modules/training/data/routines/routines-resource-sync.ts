import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { RoutineDto, toLocalRoutine } from './routine';
import { ROUTINES_PATH } from './routine-api';
import { RoutineRepository } from './routine-repository';

/** As rotinas como recurso sincronizável: o servidor entrega a rotina inteira, aqui se converte e se funde. */
@Injectable()
export class RoutinesResourceSync implements ResourceSync<RoutineDto> {
  private readonly repository = inject(RoutineRepository);

  readonly resource = 'routines';
  readonly path = ROUTINES_PATH;

  merge(items: readonly RoutineDto[]): Promise<void> {
    return this.repository.applyRemote(items.map(toLocalRoutine));
  }
}

/**
 * Tudo o que as rotinas registram no módulo: o acesso aos dados e o recurso sincronizável. `provideTrainingData`
 * o chama numa linha só.
 */
export function provideRoutinesData(): Provider[] {
  return [RoutineRepository, provideResourceSync(RoutinesResourceSync)];
}
