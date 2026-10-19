import { item, items } from '../routines/routine-test-kit';
import { nextTarget, planProgress, prefillFor, sessionSummary } from './session-plan';

const done = (exerciseId: string, count: number, setType = 'work') =>
  Array.from({ length: count }, () => ({ exerciseId, setType }));

/** Rotina de três exercícios soltos: a (3 séries), b (2) e c (1). */
const plain = [
  item('a', 0, { targetSets: 3, restSeconds: 90 }),
  item('b', 1, { targetSets: 2, restSeconds: 60 }),
  item('c', 2, { targetSets: 1, restSeconds: 30 }),
];

describe('nextTarget', () => {
  it('starts at the first set of the first exercise', () => {
    expect(nextTarget(plain, [])).toMatchObject({
      exerciseId: 'ex-a',
      itemId: 'a',
      setNumber: 1,
      targetSets: 3,
      rest: true,
      restSeconds: 90,
    });
  });

  it('walks an exercise set by set, then moves to the next one', () => {
    expect(nextTarget(plain, done('ex-a', 2))).toMatchObject({ exerciseId: 'ex-a', setNumber: 3 });
    expect(nextTarget(plain, done('ex-a', 3))).toMatchObject({ exerciseId: 'ex-b', setNumber: 1 });
    expect(nextTarget(plain, [...done('ex-a', 3), ...done('ex-b', 1)])).toMatchObject({
      exerciseId: 'ex-b',
      setNumber: 2,
    });
  });

  it('is null when every set of the routine is done, and the last set has no rest after it', () => {
    const all = [...done('ex-a', 3), ...done('ex-b', 2), ...done('ex-c', 1)];
    expect(nextTarget(plain, all)).toBeNull();

    const lastOne = nextTarget(plain, [...done('ex-a', 3), ...done('ex-b', 2)]);
    expect(lastOne).toMatchObject({ exerciseId: 'ex-c', setNumber: 1, rest: false });
  });

  it('does not count warm-up sets toward the target', () => {
    const sets = [...done('ex-a', 2, 'warmup'), ...done('ex-a', 1)];

    expect(nextTarget(plain, sets)).toMatchObject({ exerciseId: 'ex-a', setNumber: 2 });
    expect(nextTarget(plain, done('ex-a', 5, 'warmup'))).toMatchObject({
      exerciseId: 'ex-a',
      setNumber: 1,
    });
  });

  it('counts failure and drop sets as working sets', () => {
    const sets = [...done('ex-a', 1), ...done('ex-a', 1, 'failure'), ...done('ex-a', 1, 'drop')];

    expect(nextTarget(plain, sets)).toMatchObject({ exerciseId: 'ex-b', setNumber: 1 });
  });

  it('follows the order of the positions, not the order of the array', () => {
    const shuffled = [plain[2], plain[0], plain[1]];

    expect(nextTarget(shuffled, [])).toMatchObject({ exerciseId: 'ex-a' });
  });

  describe('supersets', () => {
    const superset = [
      item('a', 0, { targetSets: 2, restSeconds: 90, supersetGroup: 1 }),
      item('b', 1, { targetSets: 2, restSeconds: 75, supersetGroup: 1 }),
      item('c', 2, { targetSets: 1, restSeconds: 30 }),
    ];

    it('alternates A1, B1, rest, A2, B2, rest with no rest in the middle of the pair', () => {
      const sequence: { exerciseId: string; setNumber: number; rest: boolean }[] = [];
      const sets: { exerciseId: string; setType: string }[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const target = nextTarget(superset, sets);
        if (target === null) break;
        sequence.push({
          exerciseId: target.exerciseId,
          setNumber: target.setNumber,
          rest: target.rest,
        });
        sets.push({ exerciseId: target.exerciseId, setType: 'work' });
      }

      expect(sequence).toEqual([
        { exerciseId: 'ex-a', setNumber: 1, rest: false },
        { exerciseId: 'ex-b', setNumber: 1, rest: true },
        { exerciseId: 'ex-a', setNumber: 2, rest: false },
        { exerciseId: 'ex-b', setNumber: 2, rest: true },
        { exerciseId: 'ex-c', setNumber: 1, rest: false },
      ]);
    });

    it('uses the rest of the item that closes the round', () => {
      const afterA1 = nextTarget(superset, done('ex-a', 1));

      expect(afterA1).toMatchObject({ exerciseId: 'ex-b', restSeconds: 75, rest: true });
    });

    it('handles a superset whose items have different numbers of sets', () => {
      const uneven = [
        item('a', 0, { targetSets: 3, supersetGroup: 1 }),
        item('b', 1, { targetSets: 1, supersetGroup: 1 }),
      ];
      const sequence: string[] = [];
      const sets: { exerciseId: string; setType: string }[] = [];
      for (let guard = 0; guard < 10; guard++) {
        const target = nextTarget(uneven, sets);
        if (target === null) break;
        sequence.push(`${target.exerciseId}${target.setNumber}${target.rest ? '*' : ''}`);
        sets.push({ exerciseId: target.exerciseId, setType: 'work' });
      }

      // O B só tem uma série: depois da primeira rodada o A segue sozinho e descansa a cada série.
      expect(sequence).toEqual(['ex-a1', 'ex-b1*', 'ex-a2*', 'ex-a3']);
    });

    it('continues from where the user stopped when the pair was left in the middle', () => {
      const sets = [...done('ex-a', 1), ...done('ex-b', 1), ...done('ex-a', 1)];

      expect(nextTarget(superset, sets)).toMatchObject({ exerciseId: 'ex-b', setNumber: 2 });
    });
  });

  describe('skipped exercises', () => {
    it('leave the plan, and the sets already done stay done', () => {
      expect(nextTarget(plain, [], ['ex-a'])).toMatchObject({ exerciseId: 'ex-b', setNumber: 1 });
      expect(nextTarget(plain, done('ex-a', 1), ['ex-a'])).toMatchObject({ exerciseId: 'ex-b' });
      expect(nextTarget(plain, [], ['ex-a', 'ex-b', 'ex-c'])).toBeNull();
    });

    it('make the last set before the end of the plan the one without rest', () => {
      expect(nextTarget(plain, [...done('ex-a', 3), ...done('ex-b', 1)], ['ex-c'])).toMatchObject({
        exerciseId: 'ex-b',
        setNumber: 2,
        rest: false,
      });
    });

    it('skip a whole superset together with its rest', () => {
      const superset = items([1, 1, null]);

      expect(nextTarget(superset, [], ['ex-a', 'ex-b'])).toMatchObject({ exerciseId: 'ex-c' });
    });
  });

  it('is null for a free workout (no routine items)', () => {
    expect(nextTarget([], done('ex-livre', 2))).toBeNull();
  });

  it('shares the done sets between two items of the same exercise, in order', () => {
    const twice = [
      item('a', 0, { exerciseId: 'ex-x', targetSets: 2 }),
      item('b', 1, { exerciseId: 'ex-y', targetSets: 1 }),
      item('c', 2, { exerciseId: 'ex-x', targetSets: 2 }),
    ];

    expect(nextTarget(twice, done('ex-x', 3), [])).toMatchObject({ exerciseId: 'ex-y' });
    expect(nextTarget(twice, [...done('ex-x', 3), ...done('ex-y', 1)])).toMatchObject({
      itemId: 'c',
      setNumber: 2,
    });
  });
});

describe('planProgress', () => {
  it('lists the routine items with their progress', () => {
    const progress = planProgress(
      plain,
      [...done('ex-a', 2), ...done('ex-b', 1, 'warmup')],
      ['ex-c'],
    );

    expect(progress.entries).toEqual([
      { exerciseId: 'ex-a', itemId: 'a', targetSets: 3, doneSets: 2, skipped: false, extra: false },
      { exerciseId: 'ex-b', itemId: 'b', targetSets: 2, doneSets: 0, skipped: false, extra: false },
      { exerciseId: 'ex-c', itemId: 'c', targetSets: 1, doneSets: 0, skipped: true, extra: false },
    ]);
  });

  it('shows an exercise done outside the routine as an extra, without a target', () => {
    const sets = [...done('ex-a', 3), ...done('ex-extra', 2), ...done('ex-extra', 1, 'warmup')];

    const progress = planProgress(plain, sets);

    expect(progress.entries.at(-1)).toEqual({
      exerciseId: 'ex-extra',
      itemId: null,
      targetSets: null,
      doneSets: 2,
      skipped: false,
      extra: true,
    });
    // O extra nunca vira alvo: o plano segue na rotina.
    expect(progress.next).toMatchObject({ exerciseId: 'ex-b' });
  });

  it('keeps a replaced exercise pending until it is skipped, and lists the substitute as an extra', () => {
    const sets = done('ex-substituto', 3);

    expect(planProgress(plain, sets).next).toMatchObject({ exerciseId: 'ex-a', setNumber: 1 });
    expect(planProgress(plain, sets, ['ex-a']).next).toMatchObject({ exerciseId: 'ex-b' });
    expect(planProgress(plain, sets).entries.find((entry) => entry.extra)).toMatchObject({
      exerciseId: 'ex-substituto',
      doneSets: 3,
    });
  });

  it('lists every exercise as an extra in a free workout, in the order they were done', () => {
    const progress = planProgress([], [...done('ex-x', 1), ...done('ex-y', 2), ...done('ex-x', 1)]);

    expect(
      progress.entries.map((entry) => [entry.exerciseId, entry.doneSets, entry.extra]),
    ).toEqual([
      ['ex-x', 2, true],
      ['ex-y', 2, true],
    ]);
    expect(progress.next).toBeNull();
  });
});

describe('prefillFor', () => {
  const prior = [
    { weightKg: 80, reps: 8, durationS: null },
    { weightKg: 82.5, reps: 6, durationS: null },
    { weightKg: 85, reps: 4, durationS: null },
  ];

  it('gives the set of the same number from last time', () => {
    expect(prefillFor(prior, 1)).toEqual({ weightKg: 80, reps: 8, durationS: null });
    expect(prefillFor(prior, 2)).toEqual({ weightKg: 82.5, reps: 6, durationS: null });
  });

  it('gives the last one when this time already went past what last time had', () => {
    expect(prefillFor(prior, 5)).toEqual({ weightKg: 85, reps: 4, durationS: null });
  });

  it('is null without history, and never reads before the first set', () => {
    expect(prefillFor([], 1)).toBeNull();
    expect(prefillFor(prior, 0)).toEqual({ weightKg: 80, reps: 8, durationS: null });
  });
});

describe('sessionSummary', () => {
  const exercises = new Map([
    ['supino', { recordType: 'weight_reps', equipment: 'barbell' }],
    ['rosca', { recordType: 'weight_reps', equipment: 'dumbbell' }],
    ['flexao', { recordType: 'reps_only', equipment: 'bodyweight' }],
    ['prancha', { recordType: 'time', equipment: 'bodyweight' }],
  ]);
  const session = { startedAt: 1_000_000, finishedAt: 1_000_000 + 3_000_000 };
  const set = (
    exerciseId: string,
    weightKg: number | null,
    reps: number | null,
    setType = 'work',
  ) => ({ exerciseId, setType, weightKg, reps });

  it('sums load times reps of the working sets and counts them', () => {
    const summary = sessionSummary(
      [set('supino', 80, 8), set('supino', 82.5, 6), set('flexao', null, 20)],
      exercises,
      session,
    );

    expect(summary.workingSets).toBe(3);
    expect(summary.volumeKg).toBe(80 * 8 + 82.5 * 6);
    expect(summary.durationMs).toBe(3_000_000);
  });

  it('leaves the warm-up out of the volume and of the count of working sets', () => {
    const summary = sessionSummary(
      [set('supino', 40, 12, 'warmup'), set('supino', 60, 10, 'warmup'), set('supino', 80, 8)],
      exercises,
      session,
    );

    expect(summary.workingSets).toBe(1);
    expect(summary.warmupSets).toBe(2);
    expect(summary.volumeKg).toBe(640);
  });

  it('counts the load of one dumbbell, as the mock does (it is not doubled)', () => {
    const summary = sessionSummary(
      [set('rosca', 14, 10), set('rosca', 14, 10)],
      exercises,
      session,
    );

    expect(summary.volumeKg).toBe(280);
    expect(summary.exercises).toEqual([{ exerciseId: 'rosca', workingSets: 2, volumeKg: 280 }]);
  });

  it('breaks the numbers down by exercise, in the order they appear', () => {
    const summary = sessionSummary(
      [
        set('supino', 80, 8),
        set('rosca', 14, 10),
        set('supino', 80, 6),
        set('prancha', null, null),
      ],
      exercises,
      session,
    );

    expect(summary.exercises).toEqual([
      { exerciseId: 'supino', workingSets: 2, volumeKg: 1120 },
      { exerciseId: 'rosca', workingSets: 1, volumeKg: 140 },
      { exerciseId: 'prancha', workingSets: 1, volumeKg: 0 },
    ]);
  });

  it('ignores a load recorded on an exercise that is not load and reps', () => {
    expect(sessionSummary([set('flexao', 10, 20)], exercises, session).volumeKg).toBe(0);
  });

  it('rounds away the floating point noise', () => {
    expect(
      sessionSummary([set('supino', 0.1, 3), set('supino', 0.2, 3)], exercises, session).volumeKg,
    ).toBe(0.9);
  });

  it('has no duration while the session is open, and an empty summary without sets', () => {
    const summary = sessionSummary([], exercises, { startedAt: 1, finishedAt: null });

    expect(summary).toEqual({
      workingSets: 0,
      warmupSets: 0,
      volumeKg: 0,
      durationMs: null,
      exercises: [],
    });
  });
});
