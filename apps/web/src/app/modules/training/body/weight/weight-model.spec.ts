import type { LocalBodyEntry } from '../../data/body/body-entry';
import {
  buildWeightChart,
  periodStart,
  rowsInPeriod,
  summarizeWeight,
  weightRows,
} from './weight-model';

const row = (date: string, weightKg: number, id = date): LocalBodyEntry => ({
  id,
  measuredOn: date,
  weightKg,
  bodyFatPct: null,
  fatMethod: null,
  waistCm: null,
  neckCm: null,
  hipCm: null,
  armCm: null,
  thighCm: null,
  note: '',
  updatedAt: 0,
  clientUpdatedAt: Date.parse(`${date}T12:00:00Z`),
  deletedAt: null,
});

describe('body weight view model', () => {
  it('keeps the history-wide trend when narrowing the visible period', () => {
    const rows = weightRows([row('2026-01-01', 80), row('2026-10-01', 79), row('2026-10-20', 78)]);
    const recent = rowsInPeriod(rows, '30d', '2026-10-22');
    expect(recent.map((item) => item.date)).toEqual(['2026-10-01', '2026-10-20']);
    expect(recent[0].trendKg).toBeCloseTo(rows[1].trendKg);
  });

  it('uses calendar months for the six-month range and clamps at month end', () => {
    expect(periodStart('6m', '2026-08-31')).toBe('2026-02-28');
    expect(periodStart('6m', '2026-10-22')).toBe('2026-04-22');
  });

  it('summarizes the newest weight and builds chart series for actual weights and trend', () => {
    const entries = [row('2026-10-20', 82.4), row('2026-10-21', 81.4)];
    const rows = weightRows(entries);
    const summary = summarizeWeight(entries, rows, '2026-10-21');
    expect(summary?.isToday).toBe(true);
    expect(summary?.delta?.deltaKg).toBeCloseTo(-0.1);
    const chart = buildWeightChart({ rows, period: 'all', today: '2026-10-21', selected: null });
    expect(chart?.ys).toEqual([82.4, 81.4]);
    expect(chart?.trendYs[1]).toBeCloseTo(82.3);
  });
});
