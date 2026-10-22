import type { components } from '../../../../core/api/generated/schema';
import { newestWins } from '../sync/merge';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';

export type MealDto = components['schemas']['MealResponse'];
export type MealUpsertBody = components['schemas']['UpsertMealRequest'];
export const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner', 'other'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export interface LocalMealEntry {
  readonly id: string;
  readonly eatenOn: string;
  readonly eatenAt: number | null;
  readonly mealType: MealType;
  readonly foodId: string | null;
  readonly name: string;
  readonly quantityGrams: number;
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbG: number;
  readonly fatG: number;
  readonly note: string;
  readonly updatedAt: number;
  readonly clientUpdatedAt: number;
  readonly deletedAt: number | null;
}

export function toLocalMeal(dto: MealDto): LocalMealEntry | null {
  if (!isMealType(dto.mealType)) return null;
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    eatenOn: dto.eatenOn,
    eatenAt: parseInstant(dto.eatenAt),
    mealType: dto.mealType,
    foodId: dto.foodId,
    name: dto.name,
    quantityGrams: toNumberOrNull(dto.quantityG) ?? 0,
    kcal: toNumberOrNull(dto.kcal) ?? 0,
    proteinG: toNumberOrNull(dto.proteinG) ?? 0,
    carbG: toNumberOrNull(dto.carbG) ?? 0,
    fatG: toNumberOrNull(dto.fatG) ?? 0,
    note: dto.note ?? '',
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

export function toMealBody(row: LocalMealEntry): MealUpsertBody {
  return {
    eatenOn: row.eatenOn,
    eatenAt: row.eatenAt === null ? null : new Date(row.eatenAt).toISOString(),
    mealType: row.mealType,
    foodId: row.foodId,
    name: row.name,
    quantityG: row.quantityGrams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbG: row.carbG,
    fatG: row.fatG,
    note: row.note === '' ? null : row.note,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted: row.deletedAt !== null,
  };
}

export function resolveMeal(local: LocalMealEntry, remote: LocalMealEntry): LocalMealEntry {
  return newestWins(local, remote);
}

function isMealType(value: string): value is MealType {
  return (MEAL_TYPES as readonly string[]).includes(value);
}
