import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { dayKey, scale, type NutritionValues } from '../../domain/nutrition/nutrition';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import { type LocalFood } from '../foods/food';
import { type LocalMealEntry, type MealType, resolveMeal, toMealBody } from './meal';
import { mealPath } from './meal-api';

export interface FoodMealDraft {
  readonly foodId: string;
  readonly grams: number;
  readonly eatenOn: string;
  readonly mealType: MealType;
  readonly eatenAt?: number | null;
  readonly note?: string;
}

export interface FreeMealDraft {
  readonly name: string;
  /** Nutrientes já calculados para a quantidade lançada. */
  readonly nutrition: NutritionValues;
  readonly eatenOn: string;
  readonly mealType: MealType;
  readonly eatenAt?: number | null;
  readonly note?: string;
}

export type MealDraft = FoodMealDraft | FreeMealDraft;
export type MealWriteResult =
  | { readonly status: 'saved'; readonly entry: LocalMealEntry }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

const QUEUE_MODULE = 'training';

/** Lançamentos de refeição sempre gravam no banco da conta antes de entrar na fila de sincronização. */
@Injectable()
export class MealRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  async entriesOf(day: string): Promise<LocalMealEntry[]> {
    return (await this.db.meals.where('eatenOn').equals(day).toArray())
      .filter((entry) => entry.deletedAt === null)
      .sort((a, b) => (a.eatenAt ?? 0) - (b.eatenAt ?? 0) || a.clientUpdatedAt - b.clientUpdatedAt);
  }

  async addEntry(draft: MealDraft): Promise<MealWriteResult> {
    if (!validBase(draft)) return { status: 'invalid' };
    let food: LocalFood | undefined;
    let values: NutritionValues;
    let name: string;
    let grams: number;
    let foodId: string | null;
    if ('foodId' in draft) {
      if (!validPortion(draft.grams)) return { status: 'invalid' };
      food = await this.db.foods.get(draft.foodId);
      if (!food || food.deletedAt !== null) return { status: 'not-found' };
      values = scale(
        {
          kcal: food.kcalPer100g,
          proteinG: food.proteinPer100g,
          carbG: food.carbsPer100g,
          fatG: food.fatPer100g,
        },
        draft.grams,
      );
      if (!validNutrition(values)) return { status: 'invalid' };
      name = food.name;
      grams = draft.grams;
      foodId = food.id;
    } else {
      if (
        !draft.name.trim() ||
        draft.name.trim().length > 160 ||
        !validNutrition(draft.nutrition)
      ) {
        return { status: 'invalid' };
      }
      values = roundNutrition(draft.nutrition);
      name = draft.name.trim();
      grams = 100;
      foodId = null;
    }
    const stamp = this.runtime.now();
    const entry: LocalMealEntry = {
      id: uuidV7(),
      eatenOn: draft.eatenOn,
      eatenAt: draft.eatenAt ?? null,
      mealType: draft.mealType,
      foodId,
      name,
      quantityGrams: grams,
      ...values,
      note: draft.note?.trim() ?? '',
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    return this.commit(entry, undefined);
  }

  async editEntry(id: string, draft: MealDraft): Promise<MealWriteResult> {
    const previous = await this.db.meals.get(id);
    if (!previous || previous.deletedAt !== null) return { status: 'not-found' };
    if (!validBase(draft)) return { status: 'invalid' };
    let values: NutritionValues;
    let name: string;
    let grams: number;
    let foodId: string | null;
    if ('foodId' in draft) {
      if (!validPortion(draft.grams)) return { status: 'invalid' };
      const food = await this.db.foods.get(draft.foodId);
      if (!food || food.deletedAt !== null) return { status: 'not-found' };
      values = scale(
        {
          kcal: food.kcalPer100g,
          proteinG: food.proteinPer100g,
          carbG: food.carbsPer100g,
          fatG: food.fatPer100g,
        },
        draft.grams,
      );
      if (!validNutrition(values)) return { status: 'invalid' };
      name = food.name;
      grams = draft.grams;
      foodId = food.id;
    } else {
      if (!draft.name.trim() || draft.name.trim().length > 160 || !validNutrition(draft.nutrition))
        return { status: 'invalid' };
      values = roundNutrition(draft.nutrition);
      name = draft.name.trim();
      grams = 100;
      foodId = null;
    }
    const stamp = Math.max(this.runtime.now(), previous.clientUpdatedAt + 1);
    const entry: LocalMealEntry = {
      ...previous,
      eatenOn: draft.eatenOn,
      eatenAt: draft.eatenAt ?? null,
      mealType: draft.mealType,
      foodId,
      name,
      quantityGrams: grams,
      ...values,
      note: draft.note?.trim() ?? '',
      updatedAt: stamp,
      clientUpdatedAt: stamp,
    };
    return this.commit(entry, previous);
  }

  async softDelete(id: string): Promise<MealWriteResult> {
    const previous = await this.db.meals.get(id);
    if (!previous || previous.deletedAt !== null) return { status: 'not-found' };
    const stamp = Math.max(this.runtime.now(), previous.clientUpdatedAt + 1);
    return this.commit(
      { ...previous, deletedAt: stamp, updatedAt: stamp, clientUpdatedAt: stamp },
      previous,
    );
  }

  async recentFoods(limit = 12): Promise<LocalFood[]> {
    const entries = (await this.db.meals.toArray())
      .filter((entry) => entry.deletedAt === null && entry.foodId !== null)
      .sort((a, b) => (b.eatenAt ?? b.updatedAt) - (a.eatenAt ?? a.updatedAt));
    const ids: string[] = [];
    for (const entry of entries)
      if (entry.foodId && !ids.includes(entry.foodId)) ids.push(entry.foodId);
    const rows = await this.db.foods.bulkGet(ids.slice(0, limit));
    return rows.filter((food): food is LocalFood => Boolean(food && food.deletedAt === null));
  }

  async applyRemote(remote: readonly LocalMealEntry[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.meals, async () => {
      const found = await this.db.meals.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalMealEntry>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveMeal);
      if (writes.length > 0) await this.db.meals.bulkPut(writes);
    });
    this.touch();
  }

  /** Dia local da instalação, compatível com as chaves de data usadas pelo corpo. */
  today(): string {
    return dayKey(this.runtime.now(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }

  private async commit(
    entry: LocalMealEntry,
    previous: LocalMealEntry | undefined,
  ): Promise<MealWriteResult> {
    await this.db.meals.put(entry);
    this.touch();
    try {
      await this.queue.enqueue({
        method: 'PUT',
        module: QUEUE_MODULE,
        url: mealPath(entry.id),
        body: toMealBody(entry),
      });
      return { status: 'saved', entry };
    } catch (error) {
      await this.undo(entry, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  private async undo(written: LocalMealEntry, previous: LocalMealEntry | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.meals, async () => {
      const current = await this.db.meals.get(written.id);
      if (current?.clientUpdatedAt !== written.clientUpdatedAt) return;
      if (previous) await this.db.meals.put(previous);
      else await this.db.meals.delete(written.id);
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}

function validBase(draft: MealDraft): boolean {
  const parsed = new Date(`${draft.eatenOn}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(draft.eatenOn) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === draft.eatenOn &&
    ['breakfast', 'lunch', 'snack', 'dinner', 'other'].includes(draft.mealType) &&
    (draft.note?.length ?? 0) <= 300 &&
    (draft.eatenAt == null || Number.isFinite(draft.eatenAt))
  );
}

function validNutrition(values: NutritionValues): boolean {
  return [values.kcal, values.proteinG, values.carbG, values.fatG].every(
    (value) =>
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 99999.99 &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
  );
}

function validPortion(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value <= 10000 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

function roundNutrition(values: NutritionValues): NutritionValues {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return {
    kcal: round(values.kcal),
    proteinG: round(values.proteinG),
    carbG: round(values.carbG),
    fatG: round(values.fatG),
  };
}
