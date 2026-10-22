import { NAVY_BODY_FAT_ENABLED } from './body-features';
import { type NavyBodyFatInput, navyBodyFat } from './navy-body-fat';

const male: NavyBodyFatInput = {
  sex: 'male',
  heightCm: 180,
  neckCm: 38,
  waistCm: 86,
  ageYears: 31,
};

const female: NavyBodyFatInput = {
  sex: 'female',
  heightCm: 165,
  neckCm: 32,
  waistCm: 75,
  hipCm: 100,
  ageYears: 31,
};

describe('navyBodyFat', () => {
  it('is on, after the constants and the measuring points were checked against independent sources', () => {
    expect(NAVY_BODY_FAT_ENABLED).toBe(true);
  });

  it('gives 16.9 % for the man of the approved example (waist 86, neck 38, height 180)', () => {
    expect(navyBodyFat(male)).toBe(16.9);
  });

  it('reproduces the worked example of an independent teaching page (31 in, 17 in, 70 in -> 6.1 %), converted to cm', () => {
    // 86,010 × log10(31 − 17) − 70,041 × log10(70) + 36,76 = 6,106 em polegadas; o app recebe centímetros.
    expect(
      navyBodyFat({ ...male, waistCm: 31 * 2.54, neckCm: 17 * 2.54, heightCm: 70 * 2.54 }),
    ).toBe(6.1);
  });

  it('gives the woman results computed with the same constants from the inch equation (checked by hand)', () => {
    // Calculado fora do app, em polegadas: 163,205 × log10(cintura + quadril − pescoço) − 97,684 × log10(altura) − 78,387.
    expect(navyBodyFat(female)).toBe(30.2);
    expect(navyBodyFat({ ...female, waistCm: 70, hipCm: 95, neckCm: 31, heightCm: 160 })).toBe(
      26.9,
    );
    expect(navyBodyFat({ ...female, waistCm: 90, hipCm: 110, neckCm: 34, heightCm: 170 })).toBe(
      39.5,
    );
  });

  it('converts centimeters to inches INSIDE the logarithm: the same person in inches gives the same result', () => {
    const inches = (cm: number) => cm / 2.54;
    const byHand =
      86.01 * Math.log10(inches(86) - inches(38)) - 70.041 * Math.log10(inches(180)) + 36.76;

    expect(navyBodyFat(male)).toBe(Math.round(byHand * 10) / 10);
    // Usar o centímetro cru no logaritmo daria outro número (a diferença é o termo constante de cada log).
    const raw = 86.01 * Math.log10(86 - 38) - 70.041 * Math.log10(180) + 36.76;
    expect(Math.abs(raw - byHand)).toBeGreaterThan(1);
  });

  it('is higher with a bigger waist and lower with a bigger neck, as the equation says', () => {
    expect(navyBodyFat({ ...male, waistCm: 96 }) as number).toBeGreaterThan(
      navyBodyFat(male) as number,
    );
    expect(navyBodyFat({ ...male, neckCm: 42 }) as number).toBeLessThan(
      navyBodyFat(male) as number,
    );
    expect(navyBodyFat({ ...female, hipCm: 110 }) as number).toBeGreaterThan(
      navyBodyFat(female) as number,
    );
  });

  it('returns a number with one decimal place', () => {
    const value = navyBodyFat({ ...male, waistCm: 87.3, neckCm: 37.4 }) as number;

    expect(Math.round(value * 10) / 10).toBe(value);
  });

  it('is null when a measurement is missing, zero or not a number', () => {
    expect(navyBodyFat({ ...male, neckCm: 0 })).toBeNull();
    expect(navyBodyFat({ ...male, waistCm: Number.NaN })).toBeNull();
    expect(navyBodyFat({ ...male, heightCm: -1 })).toBeNull();
    expect(navyBodyFat({ ...female, hipCm: null })).toBeNull();
    expect(navyBodyFat({ ...female, hipCm: undefined })).toBeNull();
    expect(navyBodyFat({ ...female, hipCm: 0 })).toBeNull();
  });

  it('is null when the waist is not bigger than the neck (the log of a non positive number)', () => {
    expect(navyBodyFat({ ...male, waistCm: 38 })).toBeNull();
    expect(navyBodyFat({ ...male, waistCm: 30 })).toBeNull();
    expect(navyBodyFat({ ...female, waistCm: 10, hipCm: 20, neckCm: 40 })).toBeNull();
  });

  it('is null under 18 years old, and from 18 on it calculates', () => {
    expect(navyBodyFat({ ...male, ageYears: 17 })).toBeNull();
    expect(navyBodyFat({ ...female, ageYears: 17 })).toBeNull();
    expect(navyBodyFat({ ...male, ageYears: 18 })).toBe(16.9);
    expect(navyBodyFat({ ...male, ageYears: Number.NaN })).toBeNull();
  });

  it('is null when the result is outside what the API accepts (2 to 70 %), instead of a number without meaning', () => {
    // Diferença de 1 cm entre cintura e pescoço: logaritmo negativo, resultado absurdo.
    expect(navyBodyFat({ ...male, waistCm: 39 })).toBeNull();
    // Muito magro pela equação (abaixo de 2 %).
    expect(navyBodyFat({ ...male, waistCm: 64, neckCm: 40, heightCm: 190 })).toBeNull();
  });

  it('is null when the feature switch is off, and only then', () => {
    expect(navyBodyFat(male, { enabled: false })).toBeNull();
    expect(navyBodyFat(male, { enabled: true })).toBe(16.9);
  });
});
