import { dayKey, dayTotals, mealTotals, remaining, scale } from './nutrition';

describe('nutrition calculations', () => {
  it('rounds calories to whole numbers and macros to two decimals', () => {
    expect(scale({ kcal: 333.33, proteinG: 12.34, carbG: 56.78, fatG: 9.87 }, 75)).toEqual({
      kcal: 250,
      proteinG: 9.26,
      carbG: 42.59,
      fatG: 7.4,
    });
    expect(scale({ kcal: 33, proteinG: 0, carbG: 0, fatG: 0 }, 51).kcal).toBe(17);
    expect(() => scale({ kcal: 1, proteinG: 0, carbG: 0, fatG: 0 }, -1)).toThrow(RangeError);
  });

  it('calculates meal and day totals for the expected daily example', () => {
    const entries = [
      { id: 'a', mealType: 'breakfast', kcal: 520, proteinG: 20, carbG: 60, fatG: 15 },
      { id: 'b', mealType: 'lunch', kcal: 780, proteinG: 35, carbG: 90, fatG: 24 },
      { id: 'c', mealType: 'snack', kcal: 340, proteinG: 10, carbG: 45, fatG: 12 },
    ];
    expect(mealTotals(entries)).toEqual({ breakfast: 520, lunch: 780, snack: 340 });
    expect(dayTotals(entries)).toEqual({ kcal: 1640, proteinG: 65, carbG: 195, fatG: 51 });
    expect(remaining(2400, dayTotals(entries).kcal)).toBe(760);
  });

  it('uses the requested civil time zone for a day key', () => {
    expect(dayKey(Date.parse('2026-01-01T02:30:00Z'), 'America/Sao_Paulo')).toBe('2025-12-31');
  });
});
