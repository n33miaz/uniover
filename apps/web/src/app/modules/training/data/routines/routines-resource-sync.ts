import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { type ProgramDto, toLocalProgram } from './program';
import { RoutineDto, toLocalRoutine } from './routine';
import { PROGRAM_PATH, ROUTINES_PATH } from './routine-api';
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

/** O programa da semana ativo como recurso sincronizável: a escolha feita em outro aparelho chega por aqui. */
@Injectable()
export class ProgramResourceSync implements ResourceSync<ProgramDto> {
  private readonly repository = inject(RoutineRepository);

  readonly resource = 'program';
  readonly path = PROGRAM_PATH;

  merge(items: readonly ProgramDto[]): Promise<void> {
    return this.repository.applyRemoteProgram(items.map(toLocalProgram));
  }
}

/**
 * Tudo o que as rotinas registram no módulo: o acesso aos dados e o recurso sincronizável. `provideTrainingData`
 * o chama numa linha só.
 */
export function provideRoutinesData(): Provider[] {
  return [
    RoutineRepository,
    provideResourceSync(RoutinesResourceSync),
    provideResourceSync(ProgramResourceSync),
  ];
}
