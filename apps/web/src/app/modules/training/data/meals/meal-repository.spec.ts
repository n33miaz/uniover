import { TestBed } from '@angular/core/testing';
import { localFood } from '../foods/food-data-test-kit';
import { TRAINING_EXPORT_SECTIONS } from '../export/export-sections';
import { localMeal, setupMeals } from './meal-data-test-kit';
import { MealsExportSection } from './meals-export-section';

describe('MealRepository', () => {
  it('copies nutrients from a food, stores offline, and queues a single write', async () => {
    const t = setupMeals();
    await t.trainingDb.foods.put(
      localFood('food-a', {
        source: 'own',
        name: 'Granola',
        kcalPer100g: 470,
        proteinPer100g: 10,
        carbsPer100g: 64,
        fatPer100g: 20,
      }),
    );

    const result = await t.repository.addEntry({
      foodId: 'food-a',
      grams: 30,
      eatenOn: '2026-10-01',
      mealType: 'snack',
    });

    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.entry).toMatchObject({
      name: 'Granola',
      quantityGrams: 30,
      kcal: 141,
      proteinG: 3,
      carbG: 19.2,
      fatG: 6,
    });
    await t.trainingDb.foods.put(
      localFood('food-a', {
        source: 'own',
        name: 'Granola atualizada',
        kcalPer100g: 500,
        proteinPer100g: 0,
        carbsPer100g: 0,
        fatPer100g: 0,
      }),
    );
    expect((await t.repository.entriesOf('2026-10-01'))[0]).toMatchObject({
      name: 'Granola',
      kcal: 141,
      proteinG: 3,
      carbG: 19.2,
      fatG: 6,
    });
    expect(await t.outbox()).toHaveLength(1);
    expect((await t.outbox())[0]).toMatchObject({
      method: 'PUT',
      module: 'training',
      url: `/api/v1/training/meals/${result.entry.id}`,
      status: 'pending',
    });
  });

  it('supports free entries, date filtering, editing, deletion tombstones, and recent foods', async () => {
    const t = setupMeals();
    await t.trainingDb.foods.put(localFood('food-a', { name: 'Arroz' }));
    await t.repository.addEntry({
      name: 'Almoço livre',
      nutrition: { kcal: 520, proteinG: 12, carbG: 80, fatG: 8 },
      eatenOn: '2026-10-01',
      mealType: 'lunch',
    });
    const saved = await t.repository.addEntry({
      foodId: 'food-a',
      grams: 150,
      eatenOn: '2026-10-02',
      mealType: 'lunch',
    });
    expect((await t.repository.entriesOf('2026-10-01')).map((entry) => entry.name)).toEqual([
      'Almoço livre',
    ]);
    expect((await t.repository.entriesOf('2026-10-02')).map((entry) => entry.name)).toEqual([
      'Arroz',
    ]);
    expect((await t.repository.recentFoods()).map((food) => food.id)).toEqual(['food-a']);
    if (saved.status !== 'saved') throw new Error('Lançamento não salvo.');

    const edited = await t.repository.editEntry(saved.entry.id, {
      name: 'Lanche livre',
      nutrition: { kcal: 100, proteinG: 2, carbG: 15, fatG: 3 },
      eatenOn: '2026-10-03',
      mealType: 'snack',
    });
    expect(edited.status).toBe('saved');
    expect(await t.repository.entriesOf('2026-10-02')).toEqual([]);
    expect((await t.repository.entriesOf('2026-10-03'))[0]).toMatchObject({
      name: 'Lanche livre',
      kcal: 100,
      foodId: null,
    });

    expect((await t.repository.softDelete(saved.entry.id)).status).toBe('saved');
    expect(await t.repository.entriesOf('2026-10-03')).toEqual([]);
    expect((await t.trainingDb.meals.get(saved.entry.id))?.deletedAt).not.toBeNull();
  });

  it('validates days and quantities before creating rows', async () => {
    const t = setupMeals();
    await t.trainingDb.foods.put(localFood('food-a'));
    expect(
      await t.repository.addEntry({
        foodId: 'food-a',
        grams: -10,
        eatenOn: '2026-10-01',
        mealType: 'lunch',
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await t.repository.addEntry({
        name: 'Inválido',
        nutrition: { kcal: -1, proteinG: 0, carbG: 0, fatG: 0 },
        eatenOn: '2026-10-01',
        mealType: 'other',
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await t.repository.addEntry({
        name: 'Dia inválido',
        nutrition: { kcal: 1, proteinG: 0, carbG: 0, fatG: 0 },
        eatenOn: '2026-02-30',
        mealType: 'other',
      }),
    ).toEqual({ status: 'invalid' });
    expect(await t.trainingDb.meals.count()).toBe(0);
    expect(await t.outbox()).toHaveLength(0);
  });

  it('enforces API quantity and calculated nutrient bounds on add and edit', async () => {
    const t = setupMeals();
    await t.trainingDb.foods.put(
      localFood('food-a', {
        kcalPer100g: 100,
        proteinPer100g: 5,
        carbsPer100g: 10,
        fatPer100g: 2,
      }),
    );
    const draft = { foodId: 'food-a', eatenOn: '2026-10-01', mealType: 'lunch' as const };

    for (const grams of [0.001, 10000.01, 10.123]) {
      expect(await t.repository.addEntry({ ...draft, grams })).toEqual({ status: 'invalid' });
    }
    expect(await t.repository.addEntry({ ...draft, grams: 10001 })).toEqual({ status: 'invalid' });
    expect(await t.trainingDb.meals.count()).toBe(0);
    expect(await t.outbox()).toHaveLength(0);

    const saved = await t.repository.addEntry({ ...draft, grams: 10000 });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(await t.repository.editEntry(saved.entry.id, { ...draft, grams: 10000.01 })).toEqual({
      status: 'invalid',
    });
    expect(
      await t.repository.editEntry(saved.entry.id, {
        ...draft,
        grams: 10000,
      }),
    ).toMatchObject({ status: 'saved' });
    expect(await t.outbox()).toHaveLength(2);
  });

  it('rejects scaled nutrients above the API maximum before enqueueing', async () => {
    const t = setupMeals();
    await t.trainingDb.foods.put(
      localFood('very-dense-food', { kcalPer100g: 99999.99, proteinPer100g: 0 }),
    );
    expect(
      await t.repository.addEntry({
        foodId: 'very-dense-food',
        grams: 10000,
        eatenOn: '2026-10-01',
        mealType: 'lunch',
      }),
    ).toEqual({ status: 'invalid' });
    expect(await t.trainingDb.meals.count()).toBe(0);
    expect(await t.outbox()).toHaveLength(0);
  });

  it('merges by client time and retains deletion tombstones', async () => {
    const t = setupMeals();
    await t.trainingDb.meals.put(
      localMeal('meal-a', { name: 'Nova refeição', clientUpdatedAt: '2026-10-02T12:00:00Z' }),
    );
    await t.repository.applyRemote([
      localMeal('meal-a', { name: 'Refeição antiga', clientUpdatedAt: '2026-10-01T12:00:00Z' }),
    ]);
    expect((await t.trainingDb.meals.get('meal-a'))?.name).toBe('Nova refeição');
    await t.repository.applyRemote([
      localMeal('meal-a', { deleted: true, clientUpdatedAt: '2026-10-03T12:00:00Z' }),
    ]);
    expect(await t.repository.entriesOf('2026-10-01')).toEqual([]);
    expect((await t.trainingDb.meals.get('meal-a'))?.deletedAt).not.toBeNull();
  });

  it('keeps entries apart when two accounts use the same local id', async () => {
    const t = setupMeals();
    const other = t.trainingDbOf('outra-conta');
    await t.trainingDb.meals.put(localMeal('same-entry', { name: 'Conta atual' }));
    await other.meals.put(localMeal('same-entry', { name: 'Outra conta' }));
    expect((await t.trainingDb.meals.get('same-entry'))?.name).toBe('Conta atual');
    expect((await other.meals.get('same-entry'))?.name).toBe('Outra conta');
  });

  it('includes live meal entries in export and excludes tombstones', async () => {
    const t = setupMeals();
    await t.trainingDb.meals.put(localMeal('meal-a', { name: 'Refeição viva' }));
    await t.trainingDb.meals.put(localMeal('meal-b', { deleted: true, name: 'Refeição removida' }));
    const section = TestBed.inject(TRAINING_EXPORT_SECTIONS).find(
      (item) => item instanceof MealsExportSection,
    );
    expect(section?.key).toBe('meals');
    expect(await section?.build()).toMatchObject([{ id: 'meal-a', name: 'Refeição viva' }]);
  });
});
