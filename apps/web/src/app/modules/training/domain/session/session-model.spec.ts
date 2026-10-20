import { type SetValues, isWorkingSet, validateFinish, validateSet } from './session-model';

const values = (overrides: Partial<SetValues> = {}): SetValues => ({
  setType: 'work',
  weightKg: 80,
  reps: 8,
  durationS: null,
  rir: null,
  rpe: null,
  note: '',
  ...overrides,
});

const codes = (issues: ReturnType<typeof validateSet>) => issues.map((issue) => issue.code);

describe('validateSet', () => {
  it('accepts a normal set and the edges of every limit', () => {
    expect(validateSet(values(), 'weight_reps')).toEqual([]);
    expect(
      validateSet(values({ weightKg: 0, reps: 0, rir: 0, rpe: 1, durationS: 0 }), 'weight_reps'),
    ).toEqual([]);
    expect(
      validateSet(
        values({
          weightKg: 99999.99,
          reps: 999,
          rir: 10,
          rpe: 10,
          durationS: 86400,
          note: 'a'.repeat(300),
        }),
        'weight_reps',
      ),
    ).toEqual([]);
    expect(validateSet(values({ rpe: 7.5 }), 'weight_reps')).toEqual([]);
  });

  it.each([
    ['weightKg', { weightKg: -1 }, 'weight-range'],
    ['weightKg', { weightKg: 100000 }, 'weight-range'],
    ['weightKg', { weightKg: 82.555 }, 'weight-range'],
    ['weightKg', { weightKg: Number.NaN }, 'weight-range'],
    ['reps', { reps: 1000 }, 'reps-range'],
    ['reps', { reps: -1 }, 'reps-range'],
    ['reps', { reps: 8.5 }, 'reps-range'],
    ['durationS', { durationS: 86401 }, 'duration-range'],
    ['rir', { rir: 11 }, 'rir-range'],
    ['rir', { rir: -1 }, 'rir-range'],
    ['rpe', { rpe: 0.5 }, 'rpe-range'],
    ['rpe', { rpe: 10.5 }, 'rpe-range'],
    ['rpe', { rpe: 7.25 }, 'rpe-range'],
    ['note', { note: 'a'.repeat(301) }, 'note-length'],
  ] as const)('refuses %s out of its limit', (path, change, code) => {
    expect(validateSet(values(change), 'weight_reps')).toEqual([{ path, code }]);
  });

  it('refuses an unknown set type', () => {
    expect(codes(validateSet(values({ setType: 'pyramid' as never }), 'weight_reps'))).toEqual([
      'set-type-invalid',
    ]);
  });

  it('asks for what the record type of the exercise needs', () => {
    expect(codes(validateSet(values({ reps: null }), 'weight_reps'))).toEqual(['reps-required']);
    expect(codes(validateSet(values({ weightKg: null }), 'weight_reps'))).toEqual([
      'weight-required',
    ]);
    expect(validateSet(values({ weightKg: null, setType: 'warmup' }), 'weight_reps')).toEqual([]);
    expect(validateSet(values({ weightKg: null, setType: 'failure' }), 'weight_reps')).toEqual([]);

    expect(codes(validateSet(values({ weightKg: null, reps: null }), 'reps_only'))).toEqual([
      'reps-required',
    ]);
    expect(validateSet(values({ weightKg: null }), 'reps_only')).toEqual([]);

    expect(codes(validateSet(values({ weightKg: null, reps: null }), 'time'))).toEqual([
      'duration-required',
    ]);
    expect(validateSet(values({ weightKg: null, reps: null, durationS: 45 }), 'time')).toEqual([]);
  });

  it('only checks the limits when the record type is not known', () => {
    expect(validateSet(values({ weightKg: null, reps: null }), null)).toEqual([]);
    expect(codes(validateSet(values({ reps: 1000 }), null))).toEqual(['reps-range']);
  });
});

describe('validateFinish', () => {
  it('accepts an empty finish and the edges', () => {
    expect(validateFinish(null, '')).toEqual([]);
    expect(validateFinish(1, 'a'.repeat(500))).toEqual([]);
    expect(validateFinish(5, '')).toEqual([]);
  });

  it('refuses a feeling out of 1 to 5 and a note that is too long', () => {
    expect(validateFinish(0, '')).toEqual(['feeling-range']);
    expect(validateFinish(6, '')).toEqual(['feeling-range']);
    expect(validateFinish(2.5, '')).toEqual(['feeling-range']);
    expect(validateFinish(3, 'a'.repeat(501))).toEqual(['note-length']);
  });
});

describe('isWorkingSet', () => {
  it('is every type but warm-up', () => {
    expect(['work', 'failure', 'drop'].every(isWorkingSet)).toBe(true);
    expect(isWorkingSet('warmup')).toBe(false);
  });
});
