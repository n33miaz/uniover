import { type WeightSample, TREND_SMOOTHING, trendDelta, weightTrend } from './weight-trend';

let order = 0;
const w = (date: string, weightKg: number | null, at: number = ++order): WeightSample => ({
  date,
  weightKg,
  order: at,
});

describe('weightTrend', () => {
  it('starts the trend with the first weighing', () => {
    expect(weightTrend([w('2026-10-01', 80)])).toEqual([
      { date: '2026-10-01', weightKg: 80, trendKg: 80 },
    ]);
  });

  it('moves a tenth of the way to each new weight', () => {
    const points = weightTrend([w('2026-10-01', 80), w('2026-10-02', 79), w('2026-10-03', 81)]);

    expect(TREND_SMOOTHING).toBe(0.1);
    expect(points[0].trendKg).toBe(80);
    expect(points[1].trendKg).toBeCloseTo(79.9, 10);
    expect(points[2].trendKg).toBeCloseTo(80.01, 10);
  });

  it('a day without weighing makes no point and does not move the trend, however long the gap', () => {
    const withGap = weightTrend([w('2026-01-01', 80), w('2026-10-01', 78)]);

    expect(withGap).toHaveLength(2);
    expect(withGap[0].trendKg).toBe(80);
    // Nove meses depois, a tendência anda só um décimo: nada de decaimento nem interpolação pelo tempo parado.
    expect(withGap[1].trendKg).toBeCloseTo(79.8, 10);
    expect(withGap.map((p) => p.date)).toEqual(['2026-01-01', '2026-10-01']);
  });

  it('with two weights on the same day, the last written one is the day', () => {
    const points = weightTrend([
      w('2026-10-01', 80, 10),
      w('2026-10-02', 82, 30),
      w('2026-10-02', 79, 20),
      w('2026-10-02', 81, 40),
    ]);

    expect(points).toHaveLength(2);
    expect(points[1].weightKg).toBe(81);
    expect(points[1].trendKg).toBeCloseTo(80.1, 10);
  });

  it('does not depend on the order the list arrives in', () => {
    const list = [w('2026-10-03', 81), w('2026-10-01', 80), w('2026-10-02', 79)];

    expect(weightTrend(list)).toEqual(weightTrend([...list].reverse()));
    expect(weightTrend(list).map((p) => p.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });

  it('ignores entries without weight, with a weight that is not a positive number, or with an invalid date', () => {
    const points = weightTrend([
      w('2026-10-01', null),
      w('2026-10-02', 0),
      w('2026-10-03', Number.NaN),
      w('2026-10-04', -5),
      w('2026-02-31', 80),
      w('2026-10-05', 80),
    ]);

    expect(points).toEqual([{ date: '2026-10-05', weightKg: 80, trendKg: 80 }]);
    expect(weightTrend([])).toEqual([]);
  });

  it('a measurement without weight does not interrupt nor feed the trend', () => {
    const points = weightTrend([w('2026-10-01', 80), w('2026-10-02', null), w('2026-10-03', 79)]);

    expect(points.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-03']);
  });
});

describe('trendDelta', () => {
  const daily = (days: number, from = 80, step = -0.1): WeightSample[] =>
    Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
      return w(date, from + step * i);
    });

  it('is the trend of the last point minus the trend of the last point at least N days old', () => {
    const entries = daily(30);
    const points = weightTrend(entries);
    const latest = points[points.length - 1];
    const reference = points.find((p) => p.date === '2026-10-16') as (typeof points)[number];

    const delta = trendDelta(entries, 14);

    expect(delta).not.toBeNull();
    expect(delta?.fullWindow).toBe(true);
    expect(delta?.spanDays).toBe(14);
    expect(delta?.deltaKg).toBeCloseTo(latest.trendKg - reference.trendKg, 12);
    expect(delta?.deltaKg).toBeLessThan(0);
  });

  it('uses the last point on or before the cutoff when there is no weighing exactly N days earlier', () => {
    const entries = [w('2026-10-01', 80), w('2026-10-10', 79), w('2026-10-20', 78)];
    const points = weightTrend(entries);

    const delta = trendDelta(entries, 14);

    // 20/10 menos 14 dias é 06/10: o último ponto até lá é 01/10.
    expect(delta?.spanDays).toBe(19);
    expect(delta?.fullWindow).toBe(true);
    expect(delta?.deltaKg).toBeCloseTo(points[2].trendKg - points[0].trendKg, 12);
  });

  it('says so when the history is shorter than the window, instead of labelling it as the full window', () => {
    const delta = trendDelta([w('2026-10-01', 80), w('2026-10-06', 79)], 14);

    expect(delta?.fullWindow).toBe(false);
    expect(delta?.spanDays).toBe(5);
    expect(delta?.deltaKg).toBeCloseTo(-0.1, 10);
  });

  it('is null with fewer than two points and for a window that is not a positive whole number', () => {
    expect(trendDelta([], 14)).toBeNull();
    expect(trendDelta([w('2026-10-01', 80)], 14)).toBeNull();
    expect(trendDelta([w('2026-10-01', 80), w('2026-10-01', 81)], 14)).toBeNull();
    expect(trendDelta(daily(5), 0)).toBeNull();
    expect(trendDelta(daily(5), -3)).toBeNull();
    expect(trendDelta(daily(5), 1.5)).toBeNull();
  });
});
