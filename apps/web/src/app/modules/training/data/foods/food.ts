import type { components } from '../../../../core/api/generated/schema';
import { normalizeText } from '../../domain/text-search';
import { newestWins } from '../sync/merge';
import { parseInstant, toNumberOrNull } from '../catalog/exercise';

export type FoodDto = components['schemas']['FoodResponse'];
export type FoodUpsertBody = components['schemas']['UpsertFoodRequest'];
export const FOOD_SOURCES = ['own', 'off', 'taco'] as const;
export type FoodSource = (typeof FOOD_SOURCES)[number];

/** Linha local. O banco é por conta; alimentos de catálogo são cópias de leitura, os próprios seguem a fila. */
export interface LocalFood {
  readonly id: string;
  readonly source: FoodSource;
  readonly sourceRef: string | null;
  readonly name: string;
  readonly nameKey: string;
  readonly brand: string | null;
  readonly barcode: string | null;
  readonly kcalPer100g: number;
  readonly proteinPer100g: number;
  readonly carbsPer100g: number;
  readonly fatPer100g: number;
  readonly defaultPortionGrams: number | null;
  readonly attribution: string | null;
  readonly updatedAt: number;
  readonly clientUpdatedAt: number;
  readonly deletedAt: number | null;
}

export function toLocalFood(dto: FoodDto): LocalFood {
  const updatedAt = parseInstant(dto.updatedAt) ?? 0;
  return {
    id: dto.id,
    source: toFoodSource(dto.source),
    sourceRef: null,
    name: dto.name,
    nameKey: normalizeText(dto.name),
    brand: dto.brand,
    barcode: dto.barcode,
    kcalPer100g: toNumberOrNull(dto.kcalPer100g) ?? 0,
    proteinPer100g: toNumberOrNull(dto.proteinPer100g) ?? 0,
    carbsPer100g: toNumberOrNull(dto.carbsPer100g) ?? 0,
    fatPer100g: toNumberOrNull(dto.fatPer100g) ?? 0,
    defaultPortionGrams: toNumberOrNull(dto.defaultPortionGrams),
    attribution: dto.attribution,
    updatedAt,
    clientUpdatedAt: parseInstant(dto.clientUpdatedAt) ?? updatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

export function toFoodBody(row: LocalFood): FoodUpsertBody {
  return {
    name: row.deletedAt === null ? row.name : null,
    brand: row.brand,
    barcode: row.barcode,
    kcalPer100g: row.kcalPer100g,
    proteinPer100g: row.proteinPer100g,
    carbsPer100g: row.carbsPer100g,
    fatPer100g: row.fatPer100g,
    defaultPortionGrams: row.defaultPortionGrams,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    deleted: row.deletedAt !== null,
  };
}

export function resolveFood(local: LocalFood, remote: LocalFood): LocalFood {
  return newestWins(local, remote);
}

function toFoodSource(value: string): FoodSource {
  if ((FOOD_SOURCES as readonly string[]).includes(value)) return value as FoodSource;
  throw new Error(`Unsupported food source: ${value}`);
}
