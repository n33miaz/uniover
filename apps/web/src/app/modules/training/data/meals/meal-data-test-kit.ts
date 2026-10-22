import { TestBed } from '@angular/core/testing';
import { setupTraining } from '../sync/training-test-kit';
import type { MealDto, LocalMealEntry } from './meal';
import { toLocalMeal } from './meal';
import { MealRepository } from './meal-repository';

export function setupMeals() {
  const training = setupTraining();
  training.pause();
  return {
    ...training,
    repository: TestBed.inject(MealRepository),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

export function mealDto(id: string, overrides: Partial<MealDto> = {}): MealDto {
  return {
    id,
    eatenOn: '2026-10-01',
    eatenAt: '2026-10-01T12:00:00.000Z',
    mealType: 'lunch',
    foodId: 'food-a',
    name: 'Almoço simples',
    quantityG: 100,
    kcal: 200,
    proteinG: 10,
    carbG: 20,
    fatG: 5,
    note: null,
    updatedAt: '2026-10-01T12:00:00.000Z',
    clientUpdatedAt: '2026-10-01T12:00:00.000Z',
    deleted: false,
    ...overrides,
  };
}

export function localMeal(id: string, overrides: Partial<MealDto> = {}): LocalMealEntry {
  const row = toLocalMeal(mealDto(id, overrides));
  if (!row) throw new Error('Tipo de refeição desconhecido.');
  return row;
}
