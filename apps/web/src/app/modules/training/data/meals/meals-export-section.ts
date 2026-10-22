import { Injectable, inject } from '@angular/core';
import { TRAINING_DB } from '../training-db';
import { iso, type ExportSection } from '../export/export-sections';

/** Refeições vivas para backup. Fotos e alimentos externos ficam fora desta seção. */
@Injectable()
export class MealsExportSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'meals';

  async build(): Promise<unknown> {
    const entries = await this.db.meals.toArray();
    return entries
      .filter((entry) => entry.deletedAt === null)
      .sort((a, b) => a.eatenOn.localeCompare(b.eatenOn) || (a.eatenAt ?? 0) - (b.eatenAt ?? 0))
      .map((entry) => ({
        id: entry.id,
        eatenOn: entry.eatenOn,
        eatenAt: iso(entry.eatenAt),
        mealType: entry.mealType,
        foodId: entry.foodId,
        name: entry.name,
        quantityGrams: entry.quantityGrams,
        kcal: entry.kcal,
        proteinG: entry.proteinG,
        carbG: entry.carbG,
        fatG: entry.fatG,
        note: entry.note === '' ? null : entry.note,
        updatedAt: iso(entry.clientUpdatedAt),
      }));
  }
}
