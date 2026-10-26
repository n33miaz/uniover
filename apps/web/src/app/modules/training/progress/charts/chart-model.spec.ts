import { SAO_PAULO, at, pset } from '../../domain/progress/progress-test-kit';
import { dailyBest } from '../../domain/progress/series';
import {
  LONG_SPAN_DAYS,
  MIN_WINDOW_DAYS,
  TIME_TICKS,
  buildChartModel,
  chartRows,
  nearestIndex,
  niceScale,
} from './chart-model';

const DAY_MS = 86_400_000;
const NOW = at('2026-10-21', 12);

/**
 * Série dourada, feita à mão: seis semanas de supino, um treino por semana.
 *   29/08  32,5 × 10 → Epley 32,5 × (1 + 10/30) = 43,33
 *   05/09  35   × 10 → 46,67
 *   12/09  37,5 × 10 → 50,00
 *   19/09  40   ×  8 → 40 × (1 + 8/30)  = 50,67
 *   26/09  40   × 10 → 53,33
 *   03/10  42,5 ×  8 → 42,5 × (1 + 8/30) = 53,83
 */
const GOLDEN = [
  ['2026-08-29', 32.5, 10],
  ['2026-09-05', 35, 10],
  ['2026-09-12', 37.5, 10],
  ['2026-09-19', 40, 8],
  ['2026-09-26', 40, 10],
  ['2026-10-03', 42.5, 8],
] as const;

function golden() {
  return dailyBest(
    GOLDEN.map(([day, weightKg, reps]) => pset({ weightKg, reps, completedAt: at(day, 9) })),
    SAO_PAULO,
  );
}

const tenth = (value: number) => Math.round(value * 10) / 10;

describe('buildChartModel', () => {
  it('gives one row per day with the 1RM, the same numbers in the line and in the table', () => {
    const model = buildChartModel({
      points: golden(),
      metric: 'oneRepMax',
      period: '8w',
      now: NOW,
    });

    expect(model.rows.map((row) => row.date)).toEqual([
      '2026-08-29',
      '2026-09-05',
      '2026-09-12',
      '2026-09-19',
      '2026-09-26',
      '2026-10-03',
    ]);
    expect(model.ys.map(tenth)).toEqual([43.3, 46.7, 50, 50.7, 53.3, 53.8]);
    // A linha e a tabela saem da mesma lista: o que o leitor de tela lê é o que se vê.
    expect(model.rows.map((row) => row.valueKg)).toEqual([...model.ys]);
    expect(model.xs).toEqual(model.rows.map((row) => row.at / 1000));
    expect(model.rows[5]).toMatchObject({ topWeightKg: 42.5, topWeightReps: 8 });
  });

  it('plots the heaviest load of the day when the metric is the top weight', () => {
    const model = buildChartModel({
      points: golden(),
      metric: 'topWeight',
      period: '8w',
      now: NOW,
    });

    expect(model.ys).toEqual([32.5, 35, 37.5, 40, 40, 42.5]);
  });

  it('draws the goal only on the 1RM chart and makes room for it on the load axis', () => {
    const withGoal = buildChartModel({
      points: golden(),
      metric: 'oneRepMax',
      period: '8w',
      now: NOW,
      goalKg: 65,
    });
    expect(withGoal.goalKg).toBe(65);
    // 43,33 a 65 com 12% de folga: 40,7 a 67,6, passos de 10 → 40 a 70.
    expect(withGoal.yRange).toEqual([40, 70]);
    expect(withGoal.yTicks).toEqual([40, 50, 60, 70]);

    const withoutGoal = buildChartModel({
      points: golden(),
      metric: 'oneRepMax',
      period: '8w',
      now: NOW,
    });
    expect(withoutGoal.goalKg).toBeNull();
    // 43,33 a 53,83 com folga: 42,1 a 55,1, passos de 5 → 40 a 60.
    expect(withoutGoal.yRange).toEqual([40, 60]);
    expect(withoutGoal.yTicks).toEqual([40, 45, 50, 55, 60]);

    // Meta de 1RM não é meta de carga: no gráfico de carga ela não entra.
    const load = buildChartModel({
      points: golden(),
      metric: 'topWeight',
      period: '8w',
      now: NOW,
      goalKg: 65,
    });
    expect(load.goalKg).toBeNull();
    expect(load.yTicks).toEqual([30, 35, 40, 45]);
  });

  it('spans the whole period in the fixed periods, ending today, with four evenly spaced date marks', () => {
    const model = buildChartModel({
      points: golden(),
      metric: 'oneRepMax',
      period: '8w',
      now: NOW,
    });

    const from = NOW - 56 * DAY_MS;
    expect(model.xTicks).toHaveLength(TIME_TICKS);
    expect(model.xTicks[0]).toBe(from / 1000);
    expect(model.xTicks[TIME_TICKS - 1]).toBe(NOW / 1000);
    const gaps = model.xTicks.slice(1).map((tick, index) => tick - model.xTicks[index]);
    for (const gap of gaps) expect(gap).toBeCloseTo((56 * DAY_MS) / 1000 / 3, 6);
    // A folga das pontas: o desenho começa um pouco antes da primeira marca e termina um pouco depois da última.
    expect(model.xRange[0]).toBeLessThan(from / 1000);
    expect(model.xRange[1]).toBeGreaterThan(NOW / 1000);
    expect(model.longSpan).toBe(false);
  });

  it('starts the 6 months window at the local day of the person, the same cut the data uses', () => {
    // 28/02 às 23:30 em Brasília já é 01/03 em UTC: seis meses antes é 28/08 (e não 31/08) no relógio de quem treina.
    const now = at('2026-02-28', 23, 30);

    const model = buildChartModel({
      points: [],
      metric: 'oneRepMax',
      period: '6m',
      now,
      timeZone: SAO_PAULO,
    });

    expect(model.xTicks[0]).toBe(at('2025-08-28', 23, 30) / 1000);
    expect(model.xTicks[TIME_TICKS - 1]).toBe(now / 1000);
  });

  it('goes from the first training to today in "all", and marks a span of more than ten months', () => {
    const model = buildChartModel({
      points: golden(),
      metric: 'oneRepMax',
      period: 'all',
      now: NOW,
    });
    expect(model.xTicks[0]).toBe(model.rows[0].at / 1000);
    expect(model.xTicks[TIME_TICKS - 1]).toBe(NOW / 1000);
    expect(model.longSpan).toBe(false);

    const old = dailyBest(
      [
        pset({ weightKg: 30, reps: 10, completedAt: at('2025-04-10', 9) }),
        pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-10', 9) }),
      ],
      SAO_PAULO,
    );
    const long = buildChartModel({ points: old, metric: 'oneRepMax', period: 'all', now: NOW });
    expect(long.longSpan).toBe(true);
    expect(NOW - long.rows[0].at).toBeGreaterThan(LONG_SPAN_DAYS * DAY_MS);
  });

  it('keeps a window of at least a week when there is a single training today', () => {
    const today = dailyBest(
      [pset({ weightKg: 40, reps: 8, completedAt: NOW - 60_000 })],
      SAO_PAULO,
    );
    const model = buildChartModel({ points: today, metric: 'oneRepMax', period: 'all', now: NOW });

    expect(model.rows).toHaveLength(1);
    expect((model.xTicks[TIME_TICKS - 1] - model.xTicks[0]) * 1000).toBeCloseTo(
      MIN_WINDOW_DAYS * DAY_MS,
      3,
    );
  });

  it('gives a flat series room above and below, so the line does not stick to the top', () => {
    const flat = dailyBest(
      [
        pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-05', 9) }),
        pset({ weightKg: 40, reps: 10, completedAt: at('2026-10-12', 9) }),
      ],
      SAO_PAULO,
    );
    const model = buildChartModel({ points: flat, metric: 'topWeight', period: '8w', now: NOW });

    // 40 ± 4 (10%): 36 a 44, de 2 em 2.
    expect(model.yRange).toEqual([36, 44]);
    expect(model.yTicks).toEqual([36, 38, 40, 42, 44]);
  });

  it('has no row, but still a valid range, when nothing was trained', () => {
    const model = buildChartModel({ points: [], metric: 'oneRepMax', period: '8w', now: NOW });

    expect(model.rows).toEqual([]);
    expect(model.xs).toEqual([]);
    expect(model.yRange[1]).toBeGreaterThan(model.yRange[0]);
    expect(model.yTicks.length).toBeGreaterThan(1);
  });
});

describe('chartRows', () => {
  const mixed = dailyBest(
    [
      pset({ weightKg: 40, reps: 8, completedAt: at('2026-10-05', 9) }),
      // Só séries de mais de 10 repetições: tem carga máxima, não tem 1RM.
      pset({ weightKg: 30, reps: 15, completedAt: at('2026-10-12', 9) }),
    ],
    SAO_PAULO,
  );

  it('leaves out of the 1RM chart a day without an estimate, but keeps it in the load chart', () => {
    expect(chartRows(mixed, 'oneRepMax').map((row) => row.date)).toEqual(['2026-10-05']);
    expect(chartRows(mixed, 'topWeight').map((row) => row.date)).toEqual([
      '2026-10-05',
      '2026-10-12',
    ]);
  });
});

describe('niceScale', () => {
  it('rounds to steps of 1, 2, 2.5, 5 and 10 times a power of ten', () => {
    expect(niceScale([100, 140]).ticks).toEqual([80, 100, 120, 140, 160]);
    expect(niceScale([20, 30]).ticks).toEqual([15, 20, 25, 30, 35]);
    // 2,5 é o salto da anilha: aparece quando a faixa é curta.
    expect(niceScale([40, 47]).ticks).toEqual([37.5, 40, 42.5, 45, 47.5, 50]);
  });

  it('never goes below zero', () => {
    // A folga de 12% abaixo de zero seria -0,12: a faixa começa em 0.
    const { range, ticks } = niceScale([0, 1]);
    expect(range[0]).toBe(0);
    expect(ticks[0]).toBe(0);
  });
});

describe('nearestIndex', () => {
  it('finds the point closest to a position and is -1 without points', () => {
    expect(nearestIndex([10, 20, 40], 24)).toBe(1);
    expect(nearestIndex([10, 20, 40], 31)).toBe(2);
    expect(nearestIndex([10, 20, 40], -5)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});
