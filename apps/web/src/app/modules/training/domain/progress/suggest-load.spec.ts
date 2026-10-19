import { type SuggestionSet, reserveReps, suggestNextLoad } from './suggest-load';

const set = (
  weightKg: number | null,
  reps: number | null,
  extra: Partial<SuggestionSet> = {},
): SuggestionSet => ({ setType: 'work', weightKg, reps, ...extra });

const sets = (count: number, weightKg: number, reps: number, extra: Partial<SuggestionSet> = {}) =>
  Array.from({ length: count }, () => set(weightKg, reps, extra));

const RANGE = { repMin: 6, repMax: 10 };

describe('suggestNextLoad', () => {
  it('raises one step when every set hit the top of the range with RPE 8: try 42,5 kg, 6 to 8 repetitions', () => {
    const suggestion = suggestNextLoad({
      lastSets: sets(4, 40, 10, { rpe: 8 }),
      ...RANGE,
      stepKg: 2.5,
    });

    expect(suggestion).toEqual({ weightKg: 42.5, repsFrom: 6, repsTo: 8, reason: 'top-of-range' });
  });

  it('raises when the effort was not recorded: the effort is optional', () => {
    const suggestion = suggestNextLoad({ lastSets: sets(3, 40, 10), ...RANGE, stepKg: 2.5 });

    expect(suggestion).toMatchObject({ weightKg: 42.5, reason: 'top-of-range' });
  });

  it('raises with RIR 2 or less and blocks with more than 2', () => {
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 10, { rir: 2 }), ...RANGE, stepKg: 2.5 }),
    ).toMatchObject({
      weightKg: 42.5,
      reason: 'top-of-range',
    });
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 10, { rir: 0 }), ...RANGE, stepKg: 2.5 }).reason,
    ).toBe('top-of-range');
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 10, { rir: 3 }), ...RANGE, stepKg: 2.5 }),
    ).toEqual({
      weightKg: 40,
      repsFrom: 6,
      repsTo: 10,
      reason: 'rir-too-high',
    });
  });

  it('reads RPE as the reserve: RPE 8 is 2 repetitions in reserve, RPE 7 is 3', () => {
    expect(reserveReps(set(40, 10, { rpe: 8 }))).toBe(2);
    expect(reserveReps(set(40, 10, { rpe: 10 }))).toBe(0);
    expect(reserveReps(set(40, 10, { rpe: 7.5 }))).toBe(2.5);
    expect(reserveReps(set(40, 10))).toBeNull();
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 10, { rpe: 7 }), ...RANGE, stepKg: 2.5 }).reason,
    ).toBe('rir-too-high');
  });

  it('prefers the RIR to the RPE when both are there', () => {
    expect(reserveReps(set(40, 10, { rir: 1, rpe: 5 }))).toBe(1);
  });

  it('blocks the raise when a single set had too much in reserve', () => {
    const lastSets = [set(40, 10, { rir: 1 }), set(40, 10, { rir: 4 }), set(40, 10)];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 }).reason).toBe('rir-too-high');
  });

  it('keeps the load and says why when a set fell below the floor, and never lowers it', () => {
    const suggestion = suggestNextLoad({
      lastSets: [set(40, 10), set(40, 8), set(40, 4)],
      ...RANGE,
      stepKg: 2.5,
    });

    expect(suggestion).toEqual({ weightKg: 40, repsFrom: 6, repsTo: 10, reason: 'below-floor' });
    const worse = suggestNextLoad({ lastSets: sets(4, 40, 2), ...RANGE, stepKg: 2.5 });
    expect(worse.weightKg).toBe(40);
    expect(worse.reason).toBe('below-floor');
  });

  it('keeps the load inside the range when not every set reached the top', () => {
    const suggestion = suggestNextLoad({
      lastSets: [set(40, 10), set(40, 9), set(40, 8)],
      ...RANGE,
      stepKg: 2.5,
    });

    expect(suggestion).toEqual({ weightKg: 40, repsFrom: 6, repsTo: 10, reason: 'within-range' });
  });

  it('treats the floor as inside the range', () => {
    expect(suggestNextLoad({ lastSets: sets(3, 40, 6), ...RANGE, stepKg: 2.5 }).reason).toBe(
      'within-range',
    );
  });

  it('has no suggestion without history', () => {
    expect(suggestNextLoad({ lastSets: [], ...RANGE, stepKg: 2.5 })).toEqual({
      weightKg: null,
      repsFrom: 6,
      repsTo: 10,
      reason: 'no-history',
    });
  });

  it('has no suggestion when the last time was only warm-up or drop sets', () => {
    const lastSets = [set(20, 10, { setType: 'warmup' }), set(30, 6, { setType: 'drop' })];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 }).reason).toBe('no-history');
  });

  it('ignores warm-up and drop sets when the working sets hit the top', () => {
    const lastSets = [
      set(20, 5, { setType: 'warmup' }),
      ...sets(3, 40, 10),
      set(30, 6, { setType: 'drop' }),
    ];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 })).toMatchObject({
      weightKg: 42.5,
      reason: 'top-of-range',
    });
  });

  it('counts a failure set as a working set', () => {
    const lastSets = [...sets(2, 40, 10), set(40, 6, { setType: 'failure' })];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 }).reason).toBe('within-range');
  });

  it('rounds to the exercise step: a machine of 5 kg, a dumbbell of 2 kg', () => {
    expect(suggestNextLoad({ lastSets: sets(3, 60, 10), ...RANGE, stepKg: 5 }).weightKg).toBe(65);
    expect(suggestNextLoad({ lastSets: sets(3, 18, 10), ...RANGE, stepKg: 2 }).weightKg).toBe(20);
  });

  it('lands on a multiple of the step even when the last load was not one', () => {
    expect(suggestNextLoad({ lastSets: sets(3, 41, 10), ...RANGE, stepKg: 2.5 }).weightKg).toBe(
      42.5,
    );
    expect(
      suggestNextLoad({ lastSets: sets(3, 41, 10), ...RANGE, stepKg: 2.5 }).weightKg as number,
    ).toBeGreaterThan(41);
  });

  it('does not drift with decimal loads: 22,5 plus 2,5 is 25 and 42,5 plus 2,5 is 45', () => {
    expect(suggestNextLoad({ lastSets: sets(3, 22.5, 10), ...RANGE, stepKg: 2.5 }).weightKg).toBe(
      25,
    );
    expect(suggestNextLoad({ lastSets: sets(3, 42.5, 10), ...RANGE, stepKg: 2.5 }).weightKg).toBe(
      45,
    );
    expect(
      suggestNextLoad({ lastSets: sets(3, 0.1 + 0.2, 10), ...RANGE, stepKg: 0.5 }).weightKg,
    ).toBe(1);
  });

  it('starts from the heaviest load when the working sets used different loads', () => {
    const lastSets = [set(40, 10), set(42.5, 10), set(42.5, 10)];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 }).weightKg).toBe(45);
  });

  it('does not raise a load when the exercise has no step (body weight), and says it reached the top', () => {
    const suggestion = suggestNextLoad({ lastSets: sets(3, 0, 10), ...RANGE, stepKg: 0 });

    expect(suggestion).toEqual({ weightKg: 0, repsFrom: 6, repsTo: 10, reason: 'top-of-range' });
  });

  it('shrinks the new target to the top of a narrow range', () => {
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 9), repMin: 8, repMax: 9, stepKg: 2.5 }),
    ).toMatchObject({ repsFrom: 8, repsTo: 9 });
    expect(
      suggestNextLoad({ lastSets: sets(3, 40, 12), repMin: 8, repMax: 12, stepKg: 2.5 }),
    ).toMatchObject({ repsFrom: 8, repsTo: 10 });
  });

  it('counts more repetitions than the top as hitting the top', () => {
    expect(suggestNextLoad({ lastSets: sets(3, 40, 12), ...RANGE, stepKg: 2.5 }).reason).toBe(
      'top-of-range',
    );
  });

  it('ignores sets without load or repetitions', () => {
    const lastSets = [set(null, 10), set(40, null), ...sets(2, 40, 10)];

    expect(suggestNextLoad({ lastSets, ...RANGE, stepKg: 2.5 }).reason).toBe('top-of-range');
  });
});
