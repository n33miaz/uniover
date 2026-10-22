import { ageYears, calorieTarget, mifflinStJeor, tdee } from './energy';

describe('ageYears', () => {
  it('counts whole years and only counts the birthday on the day', () => {
    expect(ageYears('1995-06-15', '2026-06-14')).toBe(30);
    expect(ageYears('1995-06-15', '2026-06-15')).toBe(31);
    expect(ageYears('1995-06-15', '2026-10-21')).toBe(31);
    expect(ageYears('1995-12-31', '2026-01-01')).toBe(30);
  });

  it('treats 29 February as 1 March in a year without it', () => {
    expect(ageYears('2000-02-29', '2025-02-28')).toBe(24);
    expect(ageYears('2000-02-29', '2025-03-01')).toBe(25);
    expect(ageYears('2000-02-29', '2024-02-29')).toBe(24);
  });

  it('is zero in the first year, and exactly 18 on the 18th birthday', () => {
    expect(ageYears('2026-06-15', '2026-10-21')).toBe(0);
    expect(ageYears('2008-10-21', '2026-10-20')).toBe(17);
    expect(ageYears('2008-10-21', '2026-10-21')).toBe(18);
  });

  it('is null for a birth after the reference day or for an invalid date', () => {
    expect(ageYears('2026-10-22', '2026-10-21')).toBeNull();
    expect(ageYears('2027-01-01', '2026-10-21')).toBeNull();
    expect(ageYears('1995-02-30', '2026-10-21')).toBeNull();
    expect(ageYears('1995-06-15', 'hoje')).toBeNull();
  });
});

describe('mifflinStJeor', () => {
  const man = { weightKg: 82.4, heightCm: 180, ageYears: 31, sex: 'male' } as const;

  it('gives 1.799 kcal for the man of the approved example (82,4 kg, 180 cm, 31 years)', () => {
    expect(mifflinStJeor(man)).toBe(1799);
  });

  it('uses +5 for men and -161 for women, so the same body differs by 166 kcal', () => {
    const woman = mifflinStJeor({ ...man, sex: 'female' }) as number;

    expect(woman).toBe(1633);
    expect((mifflinStJeor(man) as number) - woman).toBe(166);
  });

  it('comes out in whole kilocalories, rounding the half up', () => {
    // 10 × 82,45 + 1125 − 155 + 5 = 1799,5.
    expect(mifflinStJeor({ ...man, weightKg: 82.45 })).toBe(1800);
    expect(Number.isInteger(mifflinStJeor({ ...man, weightKg: 77.77 }))).toBe(true);
  });

  it('is null under 18 years old, and from 18 on it calculates', () => {
    expect(mifflinStJeor({ ...man, ageYears: 17 })).toBeNull();
    expect(mifflinStJeor({ ...man, ageYears: 18 })).toBe(1799 + 65);
  });

  it('is null for data that is not a positive number', () => {
    expect(mifflinStJeor({ ...man, weightKg: 0 })).toBeNull();
    expect(mifflinStJeor({ ...man, heightCm: -1 })).toBeNull();
    expect(mifflinStJeor({ ...man, weightKg: Number.NaN })).toBeNull();
    expect(mifflinStJeor({ ...man, ageYears: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('tdee', () => {
  it('gives 2.788 kcal for 1.799 at the default factor 1,55', () => {
    // 1799 × 1,55 = 2788,45: o ponto flutuante dá 2788,4500000000003 e o inteiro é 2788.
    expect(tdee(1799, 1.55)).toBe(2788);
  });

  it('follows the factor the owner chose', () => {
    expect(tdee(1799, 1.2)).toBe(2159);
    expect(tdee(1799, 1.9)).toBe(3418);
    expect(tdee(1799, 1)).toBe(1799);
  });
});

describe('calorieTarget', () => {
  it('keeps the chosen target when it is not below the basal rate', () => {
    expect(calorieTarget({ chosen: 2200, bmr: 1799 })).toEqual({ target: 2200, belowBmr: false });
    expect(calorieTarget({ chosen: 1799, bmr: 1799 })).toEqual({ target: 1799, belowBmr: false });
  });

  it('never goes below the basal rate: it returns the basal rate and the warning', () => {
    expect(calorieTarget({ chosen: 1500, bmr: 1799 })).toEqual({ target: 1799, belowBmr: true });
    expect(calorieTarget({ chosen: 1798, bmr: 1799 })).toEqual({ target: 1799, belowBmr: true });
    expect(calorieTarget({ chosen: 0, bmr: 1799 })).toEqual({ target: 1799, belowBmr: true });
    expect(calorieTarget({ chosen: -500, bmr: 1799 })).toEqual({ target: 1799, belowBmr: true });
  });

  it('compares what the owner sees: a half kilocalorie rounds to the shown whole number first', () => {
    expect(calorieTarget({ chosen: 1798.6, bmr: 1799 })).toEqual({ target: 1799, belowBmr: false });
    expect(calorieTarget({ chosen: 2200.4, bmr: 1799 })).toEqual({ target: 2200, belowBmr: false });
  });

  it('treats a choice that is not a number as no choice: the basal rate, without the warning', () => {
    expect(calorieTarget({ chosen: Number.NaN, bmr: 1799 })).toEqual({
      target: 1799,
      belowBmr: false,
    });
  });
});
