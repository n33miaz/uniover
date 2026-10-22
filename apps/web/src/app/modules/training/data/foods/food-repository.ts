import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { matchesTokens, searchTokens, normalizeText } from '../../domain/text-search';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import {
  type FoodDto,
  type FoodUpsertBody,
  type LocalFood,
  resolveFood,
  toFoodBody,
  toLocalFood,
} from './food';
import { FOOD_SEARCH_PATH, foodPath } from './food-api';

export interface OwnFoodDraft {
  readonly id?: string;
  readonly name: string;
  readonly brand?: string | null;
  readonly kcalPer100g: number;
  readonly proteinPer100g: number;
  readonly carbsPer100g: number;
  readonly fatPer100g: number;
  readonly defaultPortionGrams?: number | null;
}

export type FoodWriteResult =
  | { readonly status: 'saved'; readonly food: LocalFood }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

export type FoodSearchResult =
  | { readonly status: 'ok'; readonly foods: readonly LocalFood[] }
  | { readonly status: 'offline'; readonly foods: readonly LocalFood[] }
  | { readonly status: 'invalid-query'; readonly foods: readonly LocalFood[] }
  | {
      readonly status: 'rate-limited';
      readonly foods: readonly LocalFood[];
      readonly retryAfterSeconds: number | null;
    }
  | { readonly status: 'not-configured'; readonly foods: readonly LocalFood[] }
  | { readonly status: 'unavailable'; readonly foods: readonly LocalFood[] };

const QUEUE_MODULE = 'training';

/** Acesso local aos alimentos e única saída para a busca de catálogo pelo servidor. */
@Injectable()
export class FoodRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly http = inject(HttpClient);
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  async searchLocal(query: string): Promise<LocalFood[]> {
    const tokens = searchTokens(query);
    const rows = await this.db.foods.toArray();
    return rows
      .filter(
        (row) =>
          row.deletedAt === null && (tokens.length === 0 || matchesTokens(row.nameKey, tokens)),
      )
      .sort((a, b) => a.nameKey.localeCompare(b.nameKey) || a.id.localeCompare(b.id));
  }

  /** Busca primeiro na cópia local. A consulta externa só sai quando há rede e nunca é registrada em log. */
  async searchOnline(query: string): Promise<FoodSearchResult> {
    const local = await this.searchLocal(query);
    if (!this.isOnline()) return { status: 'offline', foods: local };
    const normalized = normalizeText(query);
    if (normalized.length < 2)
      return { status: query.trim() === '' ? 'ok' : 'invalid-query', foods: local };
    if (query.trim().length > 80 || hasControlCharacter(query)) {
      return { status: 'invalid-query', foods: local };
    }

    try {
      const params = new HttpParams().set('q', query.trim());
      const remote = await firstValueFrom(this.http.get<FoodDto[]>(FOOD_SEARCH_PATH, { params }));
      await this.applyRemote(remote.map(toLocalFood));
      const found = new Map(local.map((food) => [food.id, food]));
      for (const food of remote.map(toLocalFood))
        if (food.deletedAt === null) found.set(food.id, food);
      return {
        status: 'ok',
        foods: [...found.values()].sort((a, b) => a.nameKey.localeCompare(b.nameKey)),
      };
    } catch (error) {
      const cached = await this.searchLocal(query);
      if (!(error instanceof HttpErrorResponse)) return { status: 'unavailable', foods: cached };
      if (error.status === 429) {
        return {
          status: 'rate-limited',
          foods: cached,
          retryAfterSeconds: parseRetryAfter(error.headers.get('Retry-After')),
        };
      }
      if (error.status === 503 && problemCode(error) === 'off-not-configured') {
        return { status: 'not-configured', foods: cached };
      }
      return { status: 'unavailable', foods: cached };
    }
  }

  /** Lê um alimento escolhido da cópia local, incluindo os que chegaram pela busca online. */
  async useOnline(foodId: string): Promise<LocalFood | undefined> {
    const food = await this.db.foods.get(foodId);
    return food?.source !== 'own' && food?.deletedAt === null ? food : undefined;
  }

  async saveOwn(draft: OwnFoodDraft): Promise<FoodWriteResult> {
    if (!validOwnFood(draft)) return { status: 'invalid' };
    const id = draft.id ?? uuidV7();
    const previous = await this.db.foods.get(id);
    if (previous !== undefined && previous.source !== 'own') return { status: 'not-found' };
    const stamp = Math.max(this.runtime.now(), (previous?.clientUpdatedAt ?? 0) + 1);
    const written: LocalFood = {
      id,
      source: 'own',
      sourceRef: null,
      name: draft.name.trim(),
      nameKey: normalizeText(draft.name),
      brand: draft.brand?.trim() || null,
      barcode: null,
      kcalPer100g: draft.kcalPer100g,
      proteinPer100g: draft.proteinPer100g,
      carbsPer100g: draft.carbsPer100g,
      fatPer100g: draft.fatPer100g,
      defaultPortionGrams: draft.defaultPortionGrams ?? null,
      attribution: null,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    return this.commit(written, previous);
  }

  async softDelete(id: string): Promise<FoodWriteResult> {
    const previous = await this.db.foods.get(id);
    if (previous === undefined || previous.source !== 'own' || previous.deletedAt !== null) {
      return { status: 'not-found' };
    }
    const stamp = Math.max(this.runtime.now(), previous.clientUpdatedAt + 1);
    return this.commit(
      { ...previous, deletedAt: stamp, updatedAt: stamp, clientUpdatedAt: stamp },
      previous,
    );
  }

  async applyRemote(remote: readonly LocalFood[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.foods, async () => {
      const found = await this.db.foods.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalFood>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveFood);
      if (writes.length > 0) await this.db.foods.bulkPut(writes);
    });
    this.touch();
  }

  private async commit(
    written: LocalFood,
    previous: LocalFood | undefined,
  ): Promise<FoodWriteResult> {
    await this.db.foods.put(written);
    this.touch();
    try {
      const body: FoodUpsertBody = toFoodBody(written);
      await this.queue.enqueue({
        method: 'PUT',
        module: QUEUE_MODULE,
        url: foodPath(written.id),
        body,
      });
      return { status: 'saved', food: written };
    } catch (error) {
      await this.undo(written, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  private async undo(written: LocalFood, previous: LocalFood | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.foods, async () => {
      const current = await this.db.foods.get(written.id);
      if (current?.clientUpdatedAt !== written.clientUpdatedAt) return;
      if (previous) await this.db.foods.put(previous);
      else await this.db.foods.delete(written.id);
    });
    this.touch();
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}

function validOwnFood(draft: OwnFoodDraft): boolean {
  const numbers = [draft.kcalPer100g, draft.proteinPer100g, draft.carbsPer100g, draft.fatPer100g];
  return (
    (draft.id === undefined || isUuidV7(draft.id)) &&
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= 160 &&
    (draft.brand == null || draft.brand.trim().length <= 120) &&
    numbers.every((value) => validAmount(value)) &&
    (draft.defaultPortionGrams == null ||
      (validPortion(draft.defaultPortionGrams) && draft.defaultPortionGrams > 0))
  );
}

function validPortion(value: number): boolean {
  return validAmount(value) && value <= 10000;
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function problemCode(error: HttpErrorResponse): string | null {
  const body = error.error as { readonly type?: unknown } | null;
  return typeof body?.type === 'string' ? (body.type.split('/').at(-1) ?? null) : null;
}

function validAmount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 99999.99 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
