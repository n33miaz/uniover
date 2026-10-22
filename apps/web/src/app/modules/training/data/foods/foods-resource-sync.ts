import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { type FoodDto, toLocalFood } from './food';
import { FOODS_PATH } from './food-api';
import { FoodRepository } from './food-repository';

@Injectable()
export class FoodsResourceSync implements ResourceSync<FoodDto> {
  private readonly repository = inject(FoodRepository);
  readonly resource = 'foods';
  readonly path = FOODS_PATH;

  merge(items: readonly FoodDto[]): Promise<void> {
    const rows = items.map(toLocalFood);
    return this.repository.applyRemote(rows);
  }
}

export function provideFoodsData(): Provider[] {
  return [FoodRepository, provideResourceSync(FoodsResourceSync)];
}
