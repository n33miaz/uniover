import type { LocalBodyEntry } from '../../data/body/body-entry';
import { addDaysToKey, parseDateKey } from '../../domain/body/date-key';
import {
  type TrendDelta,
  type WeightSample,
  trendDelta,
  weightTrend,
} from '../../domain/body/weight-trend';
import { niceScale } from '../../progress/charts/chart-model';
import type { ChartSpec } from '../../progress/charts/chart-types';

/**
 * Peso e tendência como a tela os mostra. Funções puras: nada de Angular, banco ou rede. A tendência vem do domínio
 * (`weightTrend`); aqui só se escolhe o recorte, se monta a janela do gráfico e se decide o que dizer ("ontem" só quando é
 * mesmo ontem).
 */

export type WeightPeriod = '30d' | '6m' | 'all';

/** Quantos dias o período curto olha para trás; seis meses usa meses de calendário. */
const PERIOD_DAYS = 30;

/** Janela mínima do eixo do tempo: com poucas pesagens os pontos não colam numa borda. */
const MIN_WINDOW_DAYS = 14;
const LONG_SPAN_DAYS = 300;
const TIME_TICKS = 4;
const MS_PER_SECOND = 1000;

/** Janela de dias da variação que a tela anuncia ("em 14 dias"). */
export const DELTA_WINDOW_DAYS = 14;

/** Uma pesagem por dia (a última do dia, que é a que vale para a tendência), com a tendência do fim do dia. */
export interface WeightRow {
  /** A medição que guarda este peso (editar e apagar mexem nela). */
  readonly id: string;
  readonly date: string;
  readonly weightKg: number;
  readonly trendKg: number;
}

export interface WeightSummary {
  readonly latest: WeightRow;
  /** A pesagem de um dia anterior à mais nova, se houver. */
  readonly previous: WeightRow | null;
  /** A mais nova é de hoje? (senão a tela diz "Última pesagem, dd/mm"). */
  readonly isToday: boolean;
  /** A anterior é de ontem? (só então a tela escreve "ontem"). */
  readonly previousIsYesterday: boolean;
  /** Quanto a tendência andou, com os dias reais da conta; `null` com menos de dois dias de pesagem. */
  readonly delta: TrendDelta | null;
}

function toSamples(entries: readonly LocalBodyEntry[]): WeightSample[] {
  return entries.map((entry) => ({
    date: entry.measuredOn,
    weightKg: entry.weightKg,
    order: entry.clientUpdatedAt,
  }));
}

/**
 * Um ponto por dia com pesagem, do mais antigo ao mais novo. A ordem da lista de entrada não importa; no mesmo dia vale
 * a gravada por último (o mesmo critério da tendência).
 */
export function weightRows(entries: readonly LocalBodyEntry[]): WeightRow[] {
  const lastOfDay = new Map<string, LocalBodyEntry>();
  for (const entry of entries) {
    if (entry.weightKg === null || !(entry.weightKg > 0)) continue;
    const current = lastOfDay.get(entry.measuredOn);
    if (
      current === undefined ||
      entry.clientUpdatedAt > current.clientUpdatedAt ||
      (entry.clientUpdatedAt === current.clientUpdatedAt && entry.id > current.id)
    ) {
      lastOfDay.set(entry.measuredOn, entry);
    }
  }
  const trend = new Map(weightTrend(toSamples(entries)).map((point) => [point.date, point]));
  const rows: WeightRow[] = [];
  for (const [date, entry] of lastOfDay) {
    const point = trend.get(date);
    if (point === undefined) continue;
    rows.push({ id: entry.id, date, weightKg: point.weightKg, trendKg: point.trendKg });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** O que o cartão do peso diz; `null` sem nenhuma pesagem. */
export function summarizeWeight(
  entries: readonly LocalBodyEntry[],
  rows: readonly WeightRow[],
  today: string,
): WeightSummary | null {
  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    latest,
    previous,
    isToday: latest.date === today,
    previousIsYesterday: previous !== null && previous.date === addDaysToKey(latest.date, -1),
    delta: trendDelta(toSamples(entries), DELTA_WINDOW_DAYS),
  };
}

/** O primeiro dia do período (inclusive), ou `null` em "Tudo". */
export function periodStart(period: WeightPeriod, today: string): string | null {
  if (period === 'all') return null;
  if (period === '30d') return addDaysToKey(today, -PERIOD_DAYS);
  const parts = parseDateKey(today);
  if (parts === null) return null;
  const monthIndex = parts.year * 12 + parts.month - 1 - 6;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(Math.min(parts.day, lastDay))}`;
}

/** As pesagens que caem no período (a tendência já vem calculada sobre todo o histórico: o recorte não a muda). */
export function rowsInPeriod(
  rows: readonly WeightRow[],
  period: WeightPeriod,
  today: string,
): WeightRow[] {
  const start = periodStart(period, today);
  return start === null ? [...rows] : rows.filter((row) => row.date >= start);
}

/** O gráfico de peso: o de linha da tela de Progresso, com a tendência como segunda série. */
export interface WeightChartSpec extends ChartSpec {
  /** A tendência, uma por ponto (mesma posição de `xs`): é a linha; os pontos são as pesagens. */
  readonly trendYs: readonly number[];
}

/** O dia como segundos desde a época, à meia-noite UTC (o eixo é de calendário, o fuso não entra). */
export function daySeconds(key: string): number {
  const parts = parseDateKey(key);
  if (parts === null) return 0;
  const date = new Date(Date.UTC(2000, parts.month - 1, parts.day));
  date.setUTCFullYear(parts.year);
  return date.getTime() / MS_PER_SECOND;
}

const dayMonthUtc = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});
const monthYearUtc = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});
const axisNumber = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** Marca do eixo do tempo: "18/10" (ou "out. de 25" quando a janela passa de dez meses). */
export function formatAxisDay(seconds: number, longSpan: boolean): string {
  const ms = seconds * MS_PER_SECOND;
  return longSpan ? monthYearUtc.format(ms).replace('.', '') : dayMonthUtc.format(ms);
}

/** Número do eixo de peso, sem unidade ("82,5"). */
export const formatAxisWeight = (value: number): string => axisNumber.format(value);

export interface WeightChartInput {
  readonly rows: readonly WeightRow[];
  readonly period: WeightPeriod;
  readonly today: string;
  readonly selected: number | null;
}

/** Monta o que o desenho precisa; `null` sem nenhum ponto no período (a tela diz isso em vez de desenhar um quadro vazio). */
export function buildWeightChart(input: WeightChartInput): WeightChartSpec | null {
  const { rows, period, today } = input;
  if (rows.length === 0) return null;

  const first = daySeconds(rows[0].date);
  const last = daySeconds(rows[rows.length - 1].date);
  const todaySeconds = daySeconds(today);
  const start = periodStart(period, today);
  // Período fixo: a janela é o período inteiro (a posição no tempo é parte da informação). "Tudo": da primeira pesagem a hoje.
  const minWindow = MIN_WINDOW_DAYS * 86_400;
  let low = start === null ? Math.min(first, todaySeconds - minWindow) : daySeconds(start);
  low = Math.min(low, first);
  const high = Math.max(todaySeconds, last);
  const pad = (high - low) * 0.04;

  const ys = rows.map((row) => row.weightKg);
  const trendYs = rows.map((row) => row.trendKg);
  const { range, ticks } = niceScale([...ys, ...trendYs]);
  const longSpan = high - low > LONG_SPAN_DAYS * 86_400;

  return {
    xs: rows.map((row) => daySeconds(row.date)),
    ys,
    trendYs,
    xRange: [low - pad, high + pad],
    yRange: range,
    xTicks: Array.from(
      { length: TIME_TICKS },
      (_, index) => low + ((high - low) * index) / (TIME_TICKS - 1),
    ),
    yTicks: ticks,
    goal: null,
    selected: input.selected,
    formatX: (seconds) => formatAxisDay(seconds, longSpan),
    formatY: formatAxisWeight,
  };
}
