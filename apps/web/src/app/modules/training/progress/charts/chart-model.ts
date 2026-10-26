import { type ProgressPeriod, periodRange } from '../../domain/progress/calendar';
import type { DailyPoint, SeriesMetric } from '../../domain/progress/series';

const DAY_MS = 86_400_000;

/**
 * Menor janela do eixo do tempo, em dias: com um treino só (ou com todos no mesmo dia) o ponto não fica colado numa
 * borda, e as marcas de data continuam distintas.
 */
export const MIN_WINDOW_DAYS = 7;

/** Acima disto (dias) as marcas do eixo do tempo passam a mostrar mês e ano em vez de dia e mês. */
export const LONG_SPAN_DAYS = 300;

/** Quantas marcas de data o eixo do tempo mostra. */
export const TIME_TICKS = 4;

/** Uma linha do gráfico e da tabela equivalente: o melhor do dia na métrica escolhida. */
export interface ChartRow {
  /** O dia local, `AAAA-MM-DD`. */
  readonly date: string;
  /** Instante (ms) da primeira série do dia. */
  readonly at: number;
  /** O valor da métrica (1RM estimado ou carga máxima do dia), em kg, sem arredondar. */
  readonly valueKg: number;
  /** A série mais pesada do dia, para o leitor ver de onde veio o dia. */
  readonly topWeightKg: number | null;
  readonly topWeightReps: number | null;
}

/**
 * Tudo o que o desenho do gráfico precisa, já calculado: a mesma lista (`rows`) alimenta a linha e a tabela de dados,
 * então as duas não têm como divergir. Sem Angular e sem biblioteca de gráfico: o teste confere os números aqui.
 */
export interface ChartModel {
  readonly metric: SeriesMetric;
  readonly rows: readonly ChartRow[];
  /** Posições no eixo do tempo, em segundos desde a época, uma por linha. */
  readonly xs: readonly number[];
  /** Valores da métrica, uma por linha. */
  readonly ys: readonly number[];
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  /** Marcas do eixo do tempo, em segundos. */
  readonly xTicks: readonly number[];
  readonly yTicks: readonly number[];
  /** A meta de 1RM do exercício, só quando a métrica é o 1RM (uma meta de 1RM não é meta de carga). */
  readonly goalKg: number | null;
  /** A janela passa de ~10 meses: as marcas de data levam o ano. */
  readonly longSpan: boolean;
}

export interface ChartInput {
  readonly points: readonly DailyPoint[];
  readonly metric: SeriesMetric;
  readonly period: ProgressPeriod;
  /** O "agora" (ms): fecha a janela do período. */
  readonly now: number;
  readonly goalKg?: number | null;
  /** O fuso de quem treina: a mesma janela de 6 meses que cortou os dados (padrão: o do aparelho). */
  readonly timeZone?: string;
}

/** As linhas do dia que têm valor na métrica (o 1RM falta em dia só com séries de mais de 10 repetições). */
export function chartRows(points: readonly DailyPoint[], metric: SeriesMetric): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const point of points) {
    const valueKg = metric === 'oneRepMax' ? point.oneRepMaxKg : point.topWeightKg;
    if (valueKg === null) continue;
    rows.push({
      date: point.date,
      at: point.at,
      valueKg,
      topWeightKg: point.topWeightKg,
      topWeightReps: point.topWeightReps,
    });
  }
  return rows;
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** O menor "passo bonito" (1, 2, 2.5, 5 × 10^n) que não é menor que o pedido; 2,5 porque é o salto da anilha. */
function niceStep(raw: number): number {
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / base;
  return (NICE_STEPS.find((step) => fraction <= step + 1e-9) ?? 10) * base;
}

const round6 = (value: number) => Number(value.toFixed(6));

/**
 * Faixa e marcas do eixo de carga: ocupa os valores com uma folga e arredonda para passos bonitos. Carga nunca vai
 * abaixo de zero. Série plana (um valor só) ganha folga própria para a linha não colar no teto.
 */
export function niceScale(
  values: readonly number[],
  targetTicks = 4,
): { range: [number, number]; ticks: number[] } {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-9) {
    const pad = Math.max(high * 0.1, 2);
    low -= pad;
    high += pad;
  } else {
    const pad = (high - low) * 0.12;
    low -= pad;
    high += pad;
  }
  low = Math.max(0, low);

  const step = niceStep((high - low) / targetTicks);
  const start = round6(Math.floor(low / step + 1e-9) * step);
  const end = round6(Math.ceil(high / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let tick = start; tick <= end + 1e-9; tick = round6(tick + step)) ticks.push(tick);
  return { range: [start, end], ticks };
}

/** Monta o modelo do gráfico de um exercício. Com zero linhas as faixas ainda existem, mas a tela nem desenha. */
export function buildChartModel(input: ChartInput): ChartModel {
  const { metric, period, now } = input;
  const rows = chartRows(input.points, metric);
  const goalKg = metric === 'oneRepMax' ? (input.goalKg ?? null) : null;

  // A janela: nos períodos fixos é o período todo (a posição do treino no tempo é parte da informação); em "Tudo" vai do
  // primeiro treino a hoje. Termina em hoje, mesmo que o último treino tenha sido antes.
  const firstAt = rows.length > 0 ? rows[0].at : null;
  const lastAt = rows.length > 0 ? rows[rows.length - 1].at : null;
  const { from } = periodRange(period, now, input.timeZone);
  let low = from ?? Math.min(firstAt ?? now, now - MIN_WINDOW_DAYS * DAY_MS);
  if (firstAt !== null) low = Math.min(low, firstAt);
  const high = Math.max(now, lastAt ?? now);

  // Uma folga nas pontas para o primeiro e o último ponto não encostarem nas bordas do desenho.
  const pad = (high - low) * 0.04;
  const xTicks = Array.from(
    { length: TIME_TICKS },
    (_, index) => (low + ((high - low) * index) / (TIME_TICKS - 1)) / 1000,
  );

  const ys = rows.map((row) => row.valueKg);
  const scaleValues = goalKg === null ? ys : [...ys, goalKg];
  const { range, ticks } = niceScale(scaleValues.length > 0 ? scaleValues : [0, 1]);

  return {
    metric,
    rows,
    xs: rows.map((row) => row.at / 1000),
    ys,
    xRange: [(low - pad) / 1000, (high + pad) / 1000],
    yRange: range,
    xTicks,
    yTicks: ticks,
    goalKg,
    longSpan: high - low > LONG_SPAN_DAYS * DAY_MS,
  };
}

/** O índice do ponto mais perto da posição `x` (mesma unidade de `xs`), ou -1 sem pontos. */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = -1;
  let bestDistance = Infinity;
  xs.forEach((value, index) => {
    const distance = Math.abs(value - x);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
