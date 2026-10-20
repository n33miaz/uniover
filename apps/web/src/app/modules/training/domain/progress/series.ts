import { dateKey } from './calendar';
import {
  DEFAULT_ONE_RM_FORMULA,
  type OneRmFormula,
  estimateSet1RM,
  isLoadSet,
} from './one-rep-max';

/** O que o progresso precisa saber de uma série (a linha local serve). */
export interface ProgressSet {
  readonly sessionId: string;
  readonly setType: string;
  readonly weightKg: number | null;
  readonly reps: number | null;
  /** Instante (ms) em que a série foi concluída. */
  readonly completedAt: number;
}

/** O melhor de um dia para um exercício. */
export interface DailyPoint {
  /** O dia local, como `AAAA-MM-DD`. */
  readonly date: string;
  /** Instante (ms) da primeira série do dia (serve de posição no eixo do tempo). */
  readonly at: number;
  /** Maior carga do dia (séries de trabalho e falha) e as repetições feitas com ela; empate fica com mais repetições. */
  readonly topWeightKg: number | null;
  readonly topWeightReps: number | null;
  /** Melhor 1RM estimado do dia (só séries de 1 a 10 repetições); `null` se nenhuma serviu. */
  readonly oneRepMaxKg: number | null;
  /** Σ carga × repetições das séries do dia, sem aquecimento (halteres contam a carga de um halter). */
  readonly volumeKg: number;
  /** Séries do dia, sem aquecimento. */
  readonly workingSets: number;
}

export type SeriesMetric = 'oneRepMax' | 'topWeight';

/** Quanto subiu da primeira à última marca com valor. */
export interface SeriesDelta {
  readonly deltaKg: number;
  /** O dia da primeira marca (`AAAA-MM-DD`): o "desde 29/08". */
  readonly sinceDate: string;
  readonly fromKg: number;
  readonly toKg: number;
}

function countsForVolume(set: ProgressSet): boolean {
  return (
    set.setType !== 'warmup' &&
    set.weightKg !== null &&
    set.weightKg > 0 &&
    set.reps !== null &&
    set.reps > 0
  );
}

/**
 * A série do exercício por dia, em ordem de data, pronta para o gráfico. Um ponto por dia local (no fuso pedido), com a
 * maior carga, o melhor 1RM estimado e o volume. Dia sem nenhuma série com carga e repetições não gera ponto.
 */
export function dailyBest(
  sets: readonly ProgressSet[],
  timeZone: string,
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): DailyPoint[] {
  const days = new Map<string, ProgressSet[]>();
  for (const set of sets) {
    const key = dateKey(set.completedAt, timeZone);
    const list = days.get(key);
    if (list) list.push(set);
    else days.set(key, [set]);
  }

  const points: DailyPoint[] = [];
  for (const [date, daySets] of days) {
    const forVolume = daySets.filter(countsForVolume);
    if (forVolume.length === 0) continue;

    let topWeightKg: number | null = null;
    let topWeightReps: number | null = null;
    let oneRepMaxKg: number | null = null;
    let volumeKg = 0;
    for (const set of forVolume) {
      volumeKg += (set.weightKg as number) * (set.reps as number);
      if (isLoadSet(set)) {
        const weight = set.weightKg as number;
        const reps = set.reps as number;
        if (
          topWeightKg === null ||
          weight > topWeightKg ||
          (weight === topWeightKg && reps > (topWeightReps ?? 0))
        ) {
          topWeightKg = weight;
          topWeightReps = reps;
        }
        const estimate = estimateSet1RM(set, formula);
        if (estimate !== null && (oneRepMaxKg === null || estimate > oneRepMaxKg)) {
          oneRepMaxKg = estimate;
        }
      }
    }
    points.push({
      date,
      at: Math.min(...daySets.map((set) => set.completedAt)),
      topWeightKg,
      topWeightReps,
      oneRepMaxKg,
      volumeKg: Math.round(volumeKg * 100) / 100,
      workingSets: forVolume.length,
    });
  }
  return points.sort((a, b) => a.at - b.at);
}

/**
 * A diferença entre a última e a primeira marca com valor da métrica (o "+10,5 kg desde 29/08"). Sem duas marcas com
 * valor não há diferença para mostrar: devolve `null`. O cálculo usa os valores sem arredondar.
 */
export function deltaSince(
  points: readonly DailyPoint[],
  metric: SeriesMetric = 'oneRepMax',
): SeriesDelta | null {
  const valueOf = (point: DailyPoint) =>
    metric === 'oneRepMax' ? point.oneRepMaxKg : point.topWeightKg;
  const withValue = points.filter((point) => valueOf(point) !== null);
  if (withValue.length < 2) return null;

  const first = withValue[0];
  const last = withValue[withValue.length - 1];
  const fromKg = valueOf(first) as number;
  const toKg = valueOf(last) as number;
  return { deltaKg: toKg - fromKg, sinceDate: first.date, fromKg, toKg };
}
