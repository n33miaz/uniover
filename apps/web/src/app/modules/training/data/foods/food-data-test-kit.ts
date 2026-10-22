import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { setupTraining } from '../sync/training-test-kit';
import type { FoodDto, LocalFood } from './food';
import { toLocalFood } from './food';
import { FoodRepository } from './food-repository';

export function setupFoods() {
  const training = setupTraining();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  training.pause();
  return {
    ...training,
    repository: TestBed.inject(FoodRepository),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

export function foodDto(id: string, overrides: Partial<FoodDto> = {}): FoodDto {
  return {
    id,
    source: 'off',
    name: 'Iogurte natural',
    brand: null,
    barcode: '78912345',
    kcalPer100g: 60,
    proteinPer100g: 4,
    carbsPer100g: 5,
    fatPer100g: 2,
    defaultPortionGrams: 170,
    attribution: 'Open Food Facts, ODbL',
    updatedAt: '2026-10-01T10:00:00.000Z',
    clientUpdatedAt: '2026-10-01T10:00:00.000Z',
    deleted: false,
    ...overrides,
  };
}

export function localFood(id: string, overrides: Partial<FoodDto> = {}): LocalFood {
  return toLocalFood(foodDto(id, overrides));
}
