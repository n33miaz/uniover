import {
  ADULT_AGE_YEARS,
  BODY_LIMITS,
  BODY_SEXES,
  type BodyEntryValues,
  DEFAULT_ACTIVITY_FACTOR,
  FAT_METHODS,
  hasAnyBodyValue,
  isBodySex,
  isFatMethod,
  validateBodyEntry,
  validateBodyProfile,
} from './body-limits';

const LATEST = '2026-10-22';

const empty: BodyEntryValues = {
  weightKg: null,
  bodyFatPct: null,
  fatMethod: null,
  waistCm: null,
  neckCm: null,
  hipCm: null,
  armCm: null,
  thighCm: null,
  note: '',
};

const weighed = (weightKg: number): BodyEntryValues => ({ ...empty, weightKg });

describe('body limits', () => {
  it('has the same values as the API', () => {
    expect(BODY_LIMITS.weightKg).toEqual({ min: 20, max: 400, decimals: 2 });
    expect(BODY_LIMITS.bodyFatPct).toEqual({ min: 2, max: 70, decimals: 1 });
    expect(BODY_LIMITS.circumferenceCm).toEqual({ min: 10, max: 250, decimals: 1 });
    expect(BODY_LIMITS.heightCm).toEqual({ min: 100, max: 250, decimals: 1 });
    expect(BODY_LIMITS.activityFactor).toEqual({ min: 1, max: 2.5, decimals: 2 });
    expect(BODY_LIMITS.noteMax).toBe(300);
    expect(BODY_LIMITS.earliestDate).toBe('1900-01-01');
    expect(DEFAULT_ACTIVITY_FACTOR).toBe(1.55);
    expect(ADULT_AGE_YEARS).toBe(18);
    expect([...FAT_METHODS]).toEqual(['navy', 'manual', 'bioimpedance']);
    expect([...BODY_SEXES]).toEqual(['male', 'female']);
  });

  it('recognizes the stable values and nothing else', () => {
    expect(isFatMethod('navy')).toBe(true);
    expect(isFatMethod('dobras')).toBe(false);
    expect(isFatMethod(null)).toBe(false);
    expect(isBodySex('female')).toBe(true);
    expect(isBodySex('outro')).toBe(false);
    expect(isBodySex(undefined)).toBe(false);
  });
});

describe('validateBodyEntry', () => {
  it('accepts one value alone, whichever it is', () => {
    const one: BodyEntryValues[] = [
      weighed(80),
      { ...empty, bodyFatPct: 15, fatMethod: 'manual' },
      { ...empty, waistCm: 80 },
      { ...empty, neckCm: 38 },
      { ...empty, hipCm: 99 },
      { ...empty, armCm: 35 },
      { ...empty, thighCm: 58 },
    ];

    for (const values of one) {
      expect(validateBodyEntry('2026-10-21', values, LATEST)).toEqual([]);
      expect(hasAnyBodyValue(values)).toBe(true);
    }
  });

  it('refuses an entry with no value, and the note alone does not count', () => {
    expect(validateBodyEntry('2026-10-21', empty, LATEST)).toEqual([
      { path: 'values', code: 'empty' },
    ]);
    expect(validateBodyEntry('2026-10-21', { ...empty, note: 'só uma anotação' }, LATEST)).toEqual([
      { path: 'values', code: 'empty' },
    ]);
    expect(hasAnyBodyValue({ ...empty, note: 'x' })).toBe(false);
  });

  it.each([
    ['weightKg', 20, 400, 19.99, 400.01, 82.456],
    ['waistCm', 10, 250, 9.9, 250.1, 86.25],
    ['neckCm', 10, 250, 9.9, 250.1, 38.55],
    ['hipCm', 10, 250, 9.9, 250.1, 99.05],
    ['armCm', 10, 250, 9.9, 250.1, 35.25],
    ['thighCm', 10, 250, 9.9, 250.1, 58.15],
  ] as const)(
    'limits %s to %d–%d with the decimals the database keeps',
    (field, min, max, below, above, tooPrecise) => {
      const at = (value: number) =>
        validateBodyEntry('2026-10-21', { ...empty, [field]: value }, LATEST);

      expect(at(min)).toEqual([]);
      expect(at(max)).toEqual([]);
      for (const bad of [below, above, tooPrecise, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(at(bad)).toEqual([{ path: field, code: 'value-range' }]);
      }
    },
  );

  it('limits the body fat to 2–70 with one decimal, and ties it to a method', () => {
    const fat = (bodyFatPct: number) =>
      validateBodyEntry('2026-10-21', { ...empty, bodyFatPct, fatMethod: 'navy' }, LATEST);

    expect(fat(2)).toEqual([]);
    expect(fat(70)).toEqual([]);
    expect(fat(16.9)).toEqual([]);
    expect(fat(1.9)).toEqual([{ path: 'bodyFatPct', code: 'value-range' }]);
    expect(fat(70.1)).toEqual([{ path: 'bodyFatPct', code: 'value-range' }]);
    expect(fat(16.95)).toEqual([{ path: 'bodyFatPct', code: 'value-range' }]);

    expect(validateBodyEntry('2026-10-21', { ...empty, bodyFatPct: 15 }, LATEST)).toEqual([
      { path: 'fatMethod', code: 'fat-method-required' },
    ]);
    expect(validateBodyEntry('2026-10-21', { ...weighed(80), fatMethod: 'navy' }, LATEST)).toEqual([
      { path: 'fatMethod', code: 'fat-method-without-fat' },
    ]);
  });

  it('limits the date to 1900 up to the last allowed day, and the note to 300 characters', () => {
    expect(validateBodyEntry('1900-01-01', weighed(80), LATEST)).toEqual([]);
    expect(validateBodyEntry(LATEST, weighed(80), LATEST)).toEqual([]);
    for (const bad of ['1899-12-31', '2026-10-23', '2026-02-31', 'ontem', '']) {
      expect(validateBodyEntry(bad, weighed(80), LATEST)).toEqual([
        { path: 'measuredOn', code: 'date-invalid' },
      ]);
    }

    expect(
      validateBodyEntry('2026-10-21', { ...weighed(80), note: 'a'.repeat(300) }, LATEST),
    ).toEqual([]);
    expect(
      validateBodyEntry('2026-10-21', { ...weighed(80), note: 'a'.repeat(301) }, LATEST),
    ).toEqual([{ path: 'note', code: 'note-too-long' }]);
    // O texto é aparado antes de contar, como a API faz.
    expect(
      validateBodyEntry('2026-10-21', { ...weighed(80), note: `  ${'a'.repeat(300)}  ` }, LATEST),
    ).toEqual([]);
  });

  it('reports every problem at once', () => {
    const issues = validateBodyEntry(
      '1800-01-01',
      { ...empty, weightKg: 5, waistCm: 1000 },
      LATEST,
    );

    expect(issues.map((issue) => issue.path).sort()).toEqual(['measuredOn', 'waistCm', 'weightKg']);
  });
});

describe('validateBodyProfile', () => {
  const profile = {
    heightCm: 180,
    birthDate: '1995-06-15',
    sex: 'male',
    activityFactor: 1.55,
  } as const;
  const TODAY = '2026-10-21';

  it('accepts the profile of the approved example and the edges of the limits', () => {
    expect(validateBodyProfile(profile, TODAY)).toEqual([]);
    expect(validateBodyProfile({ ...profile, heightCm: 100, activityFactor: 1 }, TODAY)).toEqual(
      [],
    );
    expect(validateBodyProfile({ ...profile, heightCm: 250, activityFactor: 2.5 }, TODAY)).toEqual(
      [],
    );
    expect(validateBodyProfile({ ...profile, birthDate: '1900-01-01' }, TODAY)).toEqual([]);
    expect(validateBodyProfile({ ...profile, birthDate: TODAY }, TODAY)).toEqual([]);
  });

  it('refuses a height or factor out of range or with too many decimals', () => {
    for (const heightCm of [99.9, 250.1, 180.55, Number.NaN]) {
      expect(validateBodyProfile({ ...profile, heightCm }, TODAY)).toEqual([
        { path: 'heightCm', code: 'value-range' },
      ]);
    }
    for (const activityFactor of [0.99, 2.51, 1.555]) {
      expect(validateBodyProfile({ ...profile, activityFactor }, TODAY)).toEqual([
        { path: 'activityFactor', code: 'value-range' },
      ]);
    }
  });

  it('refuses a birth date in the future, before 1900 or that does not exist, and an unknown sex', () => {
    for (const birthDate of ['2026-10-22', '1899-12-31', '1995-02-30', '']) {
      expect(validateBodyProfile({ ...profile, birthDate }, TODAY)).toEqual([
        { path: 'birthDate', code: 'date-invalid' },
      ]);
    }
    expect(validateBodyProfile({ ...profile, sex: 'outro' as 'male' }, TODAY)).toEqual([
      { path: 'sex', code: 'sex-invalid' },
    ]);
  });

  it('does not refuse a minor: the registration is free and only the calculations stop', () => {
    expect(validateBodyProfile({ ...profile, birthDate: '2015-01-01' }, TODAY)).toEqual([]);
  });
});
