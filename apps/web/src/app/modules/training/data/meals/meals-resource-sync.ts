import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { type MealDto, type LocalMealEntry, toLocalMeal } from './meal';
import { MEALS_PATH } from './meal-api';
import { MealRepository } from './meal-repository';

@Injectable()
export class MealsResourceSync implements ResourceSync<MealDto> {
  private readonly repository = inject(MealRepository);
  readonly resource = 'meals';
  readonly path = MEALS_PATH;

  merge(items: readonly MealDto[]): Promise<void> {
    const rows = items.map(toLocalMeal).filter((row): row is LocalMealEntry => row !== null);
    return this.repository.applyRemote(rows);
  }
}

export function provideMealsData(): Provider[] {
  return [MealRepository, provideResourceSync(MealsResourceSync)];
}
