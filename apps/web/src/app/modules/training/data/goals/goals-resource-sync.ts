import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { type GoalDto, type LocalGoal, toLocalGoal } from './goal';
import { GOALS_PATH } from './goal-api';
import { GoalRepository } from './goal-repository';

/** As metas como recurso sincronizável: o servidor entrega a meta, aqui se converte e se funde. */
@Injectable()
export class GoalsResourceSync implements ResourceSync<GoalDto> {
  private readonly repository = inject(GoalRepository);

  readonly resource = 'goals';
  readonly path = GOALS_PATH;

  merge(items: readonly GoalDto[]): Promise<void> {
    const rows = items.map(toLocalGoal).filter((row): row is LocalGoal => row !== null);
    return this.repository.applyRemote(rows);
  }
}

/**
 * Tudo o que as metas registram no módulo: o acesso aos dados e o recurso sincronizável. `provideTrainingData` o chama
 * numa linha só.
 */
export function provideGoalsData(): Provider[] {
  return [GoalRepository, provideResourceSync(GoalsResourceSync)];
}
