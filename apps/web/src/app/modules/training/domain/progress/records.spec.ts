import { at, pset, repeated } from './progress-test-kit';
import { REFERENCE_SESSIONS, detectLiveRecords, personalRecords, recordsInWindow } from './records';

/** O histórico de referência: 10/10 com 4 x 10 a 40 kg e 18/10 com 42,5 kg x 8. */
function referenceHistory() {
  return [
    ...repeated(4, { sessionId: 'treino-10', weightKg: 40, reps: 10 }, at('2026-10-10', 9)),
    ...repeated(3, { sessionId: 'treino-14', weightKg: 40, reps: 9 }, at('2026-10-14', 9)),
    ...repeated(3, { sessionId: 'treino-18', weightKg: 42.5, reps: 8 }, at('2026-10-18', 9)),
  ];
}

describe('personalRecords', () => {
  it('finds the four records of the reference case', () => {
    const records = personalRecords(referenceHistory());

    expect(records.maxWeight).toMatchObject({ weightKg: 42.5, reps: 8, sessionId: 'treino-18' });
    expect(records.oneRepMax?.valueKg).toBeCloseTo(53.8333, 4);
    expect(records.oneRepMax).toMatchObject({ weightKg: 42.5, reps: 8, sessionId: 'treino-18' });
    expect(records.maxSessionVolume).toMatchObject({
      volumeKg: 1600,
      sessionId: 'treino-10',
      sets: 4,
    });
    expect(records.maxRepsAtLoad).toMatchObject({ weightKg: 40, reps: 10, sessionId: 'treino-10' });
  });

  it('has nothing without history', () => {
    expect(personalRecords([])).toEqual({
      maxWeight: null,
      oneRepMax: null,
      maxSessionVolume: null,
      maxRepsAtLoad: null,
    });
  });

  it('ignores warm-up for every record and drop for the load, the 1RM and the repetitions', () => {
    const records = personalRecords([
      pset({ setType: 'warmup', weightKg: 100, reps: 5 }),
      pset({ setType: 'drop', weightKg: 80, reps: 6 }),
      pset({ setType: 'work', weightKg: 40, reps: 8 }),
    ]);

    expect(records.maxWeight?.weightKg).toBe(40);
    expect(records.oneRepMax?.weightKg).toBe(40);
    expect(records.maxSessionVolume?.volumeKg).toBe(40 * 8 + 80 * 6);
    expect(records.maxRepsAtLoad?.weightKg).toBe(40);
  });

  it('counts a failure set', () => {
    const records = personalRecords([pset({ setType: 'failure', weightKg: 50, reps: 6 })]);

    expect(records.maxWeight?.weightKg).toBe(50);
  });

  it('breaks a tie of the maximum load by the repetitions, then by the earliest', () => {
    const records = personalRecords([
      pset({ weightKg: 50, reps: 5, completedAt: at('2026-10-01'), sessionId: 'a' }),
      pset({ weightKg: 50, reps: 7, completedAt: at('2026-10-05'), sessionId: 'b' }),
      pset({ weightKg: 50, reps: 7, completedAt: at('2026-10-09'), sessionId: 'c' }),
    ]);

    expect(records.maxWeight).toMatchObject({ weightKg: 50, reps: 7, sessionId: 'b' });
  });

  it('holds the record of the earliest session when two sessions tie in volume', () => {
    const records = personalRecords([
      pset({ sessionId: 'novo', weightKg: 40, reps: 10, completedAt: at('2026-10-12') }),
      pset({ sessionId: 'velho', weightKg: 40, reps: 10, completedAt: at('2026-10-02') }),
    ]);

    expect(records.maxSessionVolume?.sessionId).toBe('velho');
  });

  it('does not give a 1RM to a history made only of sets above 10 repetitions, but keeps the load', () => {
    const records = personalRecords([
      pset({ weightKg: 30, reps: 15 }),
      pset({ weightKg: 32, reps: 12 }),
    ]);

    expect(records.maxWeight?.weightKg).toBe(32);
    expect(records.oneRepMax).toBeNull();
  });

  it('chooses the formula of the 1RM', () => {
    const history = [pset({ weightKg: 42.5, reps: 8 })];

    expect(personalRecords(history, 'epley').oneRepMax?.valueKg).toBeCloseTo(53.8333, 4);
    expect(personalRecords(history, 'brzycki').oneRepMax?.valueKg).toBeCloseTo(52.7586, 4);
  });

  describe('repetitions at the reference load', () => {
    it('uses the load most used in the last four sessions, not the heaviest one', () => {
      const history = [
        ...repeated(1, { sessionId: 's1', weightKg: 60, reps: 12 }, at('2026-09-01')),
        ...repeated(3, { sessionId: 's2', weightKg: 40, reps: 8 }, at('2026-09-20')),
        ...repeated(3, { sessionId: 's3', weightKg: 40, reps: 9 }, at('2026-09-27')),
        ...repeated(1, { sessionId: 's4', weightKg: 45, reps: 6 }, at('2026-10-04')),
        ...repeated(1, { sessionId: 's5', weightKg: 45, reps: 6 }, at('2026-10-11')),
      ];

      expect(REFERENCE_SESSIONS).toBe(4);
      expect(personalRecords(history).maxRepsAtLoad).toMatchObject({ weightKg: 40, reps: 9 });
    });

    it('does not look at sessions older than the last four', () => {
      const history = [
        // A sessão mais antiga é a única de 80 kg e fica de fora das quatro mais recentes.
        ...repeated(9, { sessionId: 'velha', weightKg: 80, reps: 5 }, at('2026-08-01')),
        ...repeated(1, { sessionId: 's2', weightKg: 40, reps: 8 }, at('2026-09-20')),
        ...repeated(1, { sessionId: 's3', weightKg: 40, reps: 8 }, at('2026-09-27')),
        ...repeated(1, { sessionId: 's4', weightKg: 42.5, reps: 8 }, at('2026-10-04')),
        ...repeated(1, { sessionId: 's5', weightKg: 40, reps: 7 }, at('2026-10-11')),
      ];

      const record = personalRecords(history).maxRepsAtLoad;

      expect(record?.weightKg).toBe(40);
    });

    it('breaks a tie of use by the heavier load', () => {
      const history = [
        pset({ sessionId: 'a', weightKg: 40, reps: 10, completedAt: at('2026-10-01') }),
        pset({ sessionId: 'b', weightKg: 45, reps: 6, completedAt: at('2026-10-08') }),
      ];

      expect(personalRecords(history).maxRepsAtLoad).toMatchObject({ weightKg: 45, reps: 6 });
    });

    it('takes the maximum of repetitions with that exact load over the whole history', () => {
      const history = [
        pset({ sessionId: 'velha', weightKg: 40, reps: 12, completedAt: at('2026-05-01') }),
        ...repeated(3, { sessionId: 's2', weightKg: 40, reps: 8 }, at('2026-09-20')),
      ];

      expect(personalRecords(history).maxRepsAtLoad).toMatchObject({
        weightKg: 40,
        reps: 12,
        sessionId: 'velha',
      });
    });

    it('treats 42,5 and 42,50 as the same load', () => {
      const history = [
        pset({ sessionId: 'a', weightKg: 42.5, reps: 8, completedAt: at('2026-10-01') }),
        pset({ sessionId: 'b', weightKg: 42.5, reps: 9, completedAt: at('2026-10-08') }),
      ];

      expect(personalRecords(history).maxRepsAtLoad).toMatchObject({ weightKg: 42.5, reps: 9 });
    });
  });
});

describe('detectLiveRecords', () => {
  const history = [pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-10') })];

  it('has no notice when the exercise has no history: the first set is never a record', () => {
    expect(detectLiveRecords([], pset({ weightKg: 100, reps: 5 }))).toEqual({
      maxWeight: null,
      oneRepMax: null,
    });
  });

  it('has no notice when the history only has warm-up and drop sets', () => {
    const quiet = [pset({ setType: 'warmup' }), pset({ setType: 'drop', weightKg: 30 })];

    expect(detectLiveRecords(quiet, pset({ weightKg: 100, reps: 5 }))).toEqual({
      maxWeight: null,
      oneRepMax: null,
    });
  });

  it('warns of a heavier load and of a better 1RM, with the previous values', () => {
    const live = detectLiveRecords(history, pset({ weightKg: 42.5, reps: 8 }));

    expect(live.maxWeight).toEqual({ previousKg: 40, weightKg: 42.5 });
    expect(live.oneRepMax?.valueKg).toBeCloseTo(53.8333, 4);
    expect(live.oneRepMax?.previousKg).toBeCloseTo(53.3333, 4);
  });

  it('warns only of the 1RM when the load is the same but the repetitions are better', () => {
    const live = detectLiveRecords(history, pset({ weightKg: 40, reps: 11 }));

    expect(live.maxWeight).toBeNull();
    // 11 repetições não entram no 1RM.
    expect(live.oneRepMax).toBeNull();

    const better = detectLiveRecords(
      [pset({ weightKg: 40, reps: 6 })],
      pset({ weightKg: 40, reps: 8 }),
    );
    expect(better.maxWeight).toBeNull();
    expect(better.oneRepMax).not.toBeNull();
  });

  it('does not warn when the set only equals the record', () => {
    expect(detectLiveRecords(history, pset({ weightKg: 40, reps: 10 }))).toEqual({
      maxWeight: null,
      oneRepMax: null,
    });
  });

  it('does not warn when the set is lower', () => {
    expect(detectLiveRecords(history, pset({ weightKg: 35, reps: 10 }))).toEqual({
      maxWeight: null,
      oneRepMax: null,
    });
  });

  it('never warns for a warm-up or a drop set, however heavy', () => {
    expect(
      detectLiveRecords(history, pset({ setType: 'warmup', weightKg: 90, reps: 5 })).maxWeight,
    ).toBeNull();
    expect(
      detectLiveRecords(history, pset({ setType: 'drop', weightKg: 90, reps: 5 })).maxWeight,
    ).toBeNull();
  });

  it('never warns for a set without load or repetitions', () => {
    expect(detectLiveRecords(history, pset({ weightKg: null, reps: 5 })).maxWeight).toBeNull();
    expect(detectLiveRecords(history, pset({ weightKg: 90, reps: null })).maxWeight).toBeNull();
    expect(detectLiveRecords(history, pset({ weightKg: 0, reps: 5 })).maxWeight).toBeNull();
  });

  it('warns of the load but not of the 1RM when there is no earlier estimate to compare with', () => {
    const live = detectLiveRecords(
      [pset({ weightKg: 30, reps: 15 })],
      pset({ weightKg: 40, reps: 8 }),
    );

    expect(live.maxWeight).toEqual({ previousKg: 30, weightKg: 40 });
    expect(live.oneRepMax).toBeNull();
  });

  it('compares with earlier sets of the same session too', () => {
    const today = [pset({ weightKg: 42.5, reps: 8, completedAt: at('2026-10-18', 9) })];

    expect(
      detectLiveRecords([...history, ...today], pset({ weightKg: 42.5, reps: 8 })).maxWeight,
    ).toBeNull();
    expect(
      detectLiveRecords([...history, ...today], pset({ weightKg: 45, reps: 6 })).maxWeight,
    ).toEqual({
      previousKg: 42.5,
      weightKg: 45,
    });
  });

  it('follows the chosen formula: 42,5 x 8 beats 40 x 10 by Epley (53,8 against 53,3) but not by Brzycki (52,8 against 53,3)', () => {
    const before = [pset({ weightKg: 40, reps: 10 })];
    const candidate = pset({ weightKg: 42.5, reps: 8 });

    expect(detectLiveRecords(before, candidate, 'epley').oneRepMax?.valueKg).toBeCloseTo(
      53.8333,
      4,
    );
    expect(detectLiveRecords(before, candidate, 'brzycki').oneRepMax).toBeNull();
    expect(detectLiveRecords(before, candidate, 'brzycki').maxWeight).toEqual({
      previousKg: 40,
      weightKg: 42.5,
    });
  });
});

describe('recordsInWindow', () => {
  const week = { from: at('2026-10-12', 0), to: at('2026-10-19', 0) };

  it('lists the records broken inside the window against what existed before it', () => {
    const sets = [
      pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-10') }),
      pset({ weightKg: 42.5, reps: 8, completedAt: at('2026-10-18') }),
    ];

    expect(recordsInWindow(sets, week.from, week.to)).toEqual(['maxWeight', 'oneRepMax']);
  });

  it('is empty when nothing was exercised before the window: a first time is not a record', () => {
    expect(
      recordsInWindow(
        [pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-14') })],
        week.from,
        week.to,
      ),
    ).toEqual([]);
  });

  it('is empty when the window did not beat the past', () => {
    const sets = [
      pset({ weightKg: 50, reps: 5, completedAt: at('2026-10-10') }),
      pset({ weightKg: 40, reps: 8, completedAt: at('2026-10-14') }),
    ];

    expect(recordsInWindow(sets, week.from, week.to)).toEqual([]);
  });

  it('ignores sets after the window', () => {
    const sets = [
      pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-10') }),
      pset({ weightKg: 60, reps: 5, completedAt: at('2026-10-20') }),
    ];

    expect(recordsInWindow(sets, week.from, week.to)).toEqual([]);
  });
});
