import { SAO_PAULO, at, pset } from './progress-test-kit';
import { dailyBest, deltaSince } from './series';

describe('dailyBest', () => {
  it('gives one point per local day, ordered by date, with the best load, the best 1RM and the volume', () => {
    const points = dailyBest(
      [
        pset({ sessionId: 'b', completedAt: at('2026-10-18', 10), weightKg: 42.5, reps: 8 }),
        pset({ sessionId: 'b', completedAt: at('2026-10-18', 10, 5), weightKg: 40, reps: 10 }),
        pset({ sessionId: 'a', completedAt: at('2026-08-29', 9), weightKg: 32.5, reps: 10 }),
      ],
      SAO_PAULO,
    );

    expect(points.map((point) => point.date)).toEqual(['2026-08-29', '2026-10-18']);
    expect(points[1]).toMatchObject({
      topWeightKg: 42.5,
      topWeightReps: 8,
      workingSets: 2,
      volumeKg: 42.5 * 8 + 40 * 10,
    });
    expect(points[1].oneRepMaxKg).toBeCloseTo(53.8333, 4);
  });

  it('takes the best 1RM of the day even when it is not the heaviest load', () => {
    const [point] = dailyBest(
      [
        pset({ weightKg: 100, reps: 1, completedAt: at('2026-10-10', 9) }),
        pset({ weightKg: 90, reps: 5, completedAt: at('2026-10-10', 9, 5) }),
      ],
      SAO_PAULO,
    );

    expect(point.topWeightKg).toBe(100);
    expect(point.oneRepMaxKg).toBeCloseTo(105, 6);
  });

  it('leaves warm-up out of everything and drop out of the load and the 1RM but not of the volume', () => {
    const [point] = dailyBest(
      [
        pset({ setType: 'warmup', weightKg: 20, reps: 10, completedAt: at('2026-10-10', 9) }),
        pset({ setType: 'work', weightKg: 40, reps: 10, completedAt: at('2026-10-10', 9, 5) }),
        pset({ setType: 'drop', weightKg: 60, reps: 6, completedAt: at('2026-10-10', 9, 10) }),
      ],
      SAO_PAULO,
    );

    expect(point.topWeightKg).toBe(40);
    expect(point.oneRepMaxKg).toBeCloseTo(53.3333, 4);
    expect(point.volumeKg).toBe(40 * 10 + 60 * 6);
    expect(point.workingSets).toBe(2);
  });

  it('keeps the load of a set above 10 repetitions but gives it no 1RM', () => {
    const [point] = dailyBest([pset({ weightKg: 30, reps: 15 })], SAO_PAULO);

    expect(point.topWeightKg).toBe(30);
    expect(point.topWeightReps).toBe(15);
    expect(point.oneRepMaxKg).toBeNull();
  });

  it('breaks a tie of the heaviest load by the most repetitions', () => {
    const [point] = dailyBest(
      [
        pset({ weightKg: 40, reps: 8, completedAt: at('2026-10-10', 9) }),
        pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-10', 9, 5) }),
      ],
      SAO_PAULO,
    );

    expect(point.topWeightReps).toBe(10);
  });

  it('skips a day that only had warm-up or sets without load and repetitions', () => {
    const points = dailyBest(
      [
        pset({ setType: 'warmup', completedAt: at('2026-10-10') }),
        pset({ weightKg: null, reps: 12, completedAt: at('2026-10-11') }),
        pset({ weightKg: 40, reps: 0, completedAt: at('2026-10-12') }),
        pset({ weightKg: 40, reps: 8, completedAt: at('2026-10-13') }),
      ],
      SAO_PAULO,
    );

    expect(points.map((point) => point.date)).toEqual(['2026-10-13']);
  });

  it('splits days at the local midnight, not at the UTC one', () => {
    const points = dailyBest(
      [
        pset({ completedAt: Date.UTC(2026, 9, 19, 2, 59, 59) }),
        pset({ completedAt: Date.UTC(2026, 9, 19, 3, 0, 0) }),
      ],
      SAO_PAULO,
    );

    expect(points.map((point) => point.date)).toEqual(['2026-10-18', '2026-10-19']);
  });

  it('uses the chosen formula', () => {
    const [epley] = dailyBest([pset({ weightKg: 42.5, reps: 8 })], SAO_PAULO, 'epley');
    const [brzycki] = dailyBest([pset({ weightKg: 42.5, reps: 8 })], SAO_PAULO, 'brzycki');

    expect(epley.oneRepMaxKg).toBeCloseTo(53.8333, 4);
    expect(brzycki.oneRepMaxKg).toBeCloseTo(52.7586, 4);
  });

  it('returns nothing for no sets', () => {
    expect(dailyBest([], SAO_PAULO)).toEqual([]);
  });
});

describe('deltaSince', () => {
  const points = dailyBest(
    [
      pset({ completedAt: at('2026-08-29'), weightKg: 32.5, reps: 10 }),
      pset({ completedAt: at('2026-09-26'), weightKg: 37.5, reps: 8 }),
      pset({ completedAt: at('2026-10-18'), weightKg: 42.5, reps: 8 }),
    ],
    SAO_PAULO,
  );

  it('+10,5 kg since 29/08: 32,5 x 10 (43,3 kg) to 42,5 x 8 (53,8 kg)', () => {
    const delta = deltaSince(points, 'oneRepMax');

    expect(delta?.sinceDate).toBe('2026-08-29');
    expect(delta?.deltaKg).toBeCloseTo(10.5, 9);
    expect(delta?.fromKg).toBeCloseTo(43.3333, 4);
    expect(delta?.toKg).toBeCloseTo(53.8333, 4);
  });

  it('measures the load too', () => {
    expect(deltaSince(points, 'topWeight')).toMatchObject({
      deltaKg: 10,
      fromKg: 32.5,
      toKg: 42.5,
    });
  });

  it('starts at the first point that has a value for the metric', () => {
    const mixed = dailyBest(
      [
        pset({ completedAt: at('2026-08-29'), weightKg: 30, reps: 15 }),
        pset({ completedAt: at('2026-09-26'), weightKg: 40, reps: 10 }),
        pset({ completedAt: at('2026-10-18'), weightKg: 42.5, reps: 8 }),
      ],
      SAO_PAULO,
    );

    expect(deltaSince(mixed, 'oneRepMax')?.sinceDate).toBe('2026-09-26');
    expect(deltaSince(mixed, 'topWeight')?.sinceDate).toBe('2026-08-29');
  });

  it('is empty with fewer than two points that have a value', () => {
    expect(deltaSince([], 'oneRepMax')).toBeNull();
    expect(deltaSince(points.slice(0, 1), 'oneRepMax')).toBeNull();
  });

  it('can be negative when the load went down', () => {
    const down = dailyBest(
      [
        pset({ completedAt: at('2026-09-01'), weightKg: 50, reps: 5 }),
        pset({ completedAt: at('2026-10-01'), weightKg: 40, reps: 5 }),
      ],
      SAO_PAULO,
    );

    expect(deltaSince(down, 'topWeight')?.deltaKg).toBe(-10);
  });
});
