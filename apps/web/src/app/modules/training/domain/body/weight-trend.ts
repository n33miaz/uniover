/**
 * Tendência de peso. Funções puras: nada de Angular, banco ou rede.
 *
 * Média móvel exponencial no estilo "The Hacker's Diet" (John Walker): cada pesagem entra com peso decrescente em potências
 * de 0,9, o que equivale a uma média simples de uns 20 dias. Na forma recursiva:
 *
 *     tendência_hoje = tendência_ontem + 0,1 × (peso_hoje − tendência_ontem)
 *
 * A primeira pesagem inicia a tendência (tendência = peso). Duas decisões de desenho são NOSSAS, não da fonte:
 * - **dia sem pesar não mexe na tendência** (não há ponto nesse dia; a tendência segue de onde parou, qualquer que seja a
 *   lacuna, e não "decai" nem é interpolada);
 * - **vários pesos no mesmo dia: vale o último do dia** (o que foi gravado por último), que é o que o dono corrigiu por cima.
 *
 * O algoritmo do MacroFactor não é público e não foi usado.
 */

import { addDaysToKey, daysBetween } from './date-key';

/** Constante de suavização: a parte da distância até o peso do dia que a tendência anda a cada pesagem. */
export const TREND_SMOOTHING = 0.1;

/** O que a tendência precisa de uma medição. */
export interface WeightSample {
  /** Dia da pesagem, `AAAA-MM-DD`. */
  readonly date: string;
  /** Peso em kg; `null` se a medição não tem peso (só medidas, por exemplo): ela não entra. */
  readonly weightKg: number | null;
  /** Qualquer número que cresce com a ordem de gravação (o relógio da escrita): decide qual é "o último do dia". */
  readonly order: number;
}

export interface TrendPoint {
  readonly date: string;
  /** Peso do dia (o último do dia). */
  readonly weightKg: number;
  /** Tendência no fim do dia. */
  readonly trendKg: number;
}

/**
 * Um ponto por dia com pesagem, do mais antigo ao mais novo. Entradas sem peso, com peso que não é número positivo ou com
 * data inválida são ignoradas. A ordem de chegada da lista não importa.
 */
export function weightTrend(entries: readonly WeightSample[]): TrendPoint[] {
  const lastOfDay = new Map<string, WeightSample & { weightKg: number }>();
  for (const entry of entries) {
    const weight = entry.weightKg;
    if (weight === null || !Number.isFinite(weight) || weight <= 0) continue;
    if (daysBetween(entry.date, entry.date) === null) continue;
    const current = lastOfDay.get(entry.date);
    if (current === undefined || entry.order >= current.order) {
      lastOfDay.set(entry.date, { ...entry, weightKg: weight });
    }
  }

  const days = [...lastOfDay.keys()].sort();
  const points: TrendPoint[] = [];
  let trend: number | null = null;
  for (const date of days) {
    const weightKg = (lastOfDay.get(date) as { weightKg: number }).weightKg;
    trend = trend === null ? weightKg : trend + TREND_SMOOTHING * (weightKg - trend);
    points.push({ date, weightKg, trendKg: trend });
  }
  return points;
}

/** Quanto a tendência andou numa janela de dias. */
export interface TrendDelta {
  /** Tendência de agora menos a do começo da janela (negativo = perdeu). Sem arredondar. */
  readonly deltaKg: number;
  /** Dias reais entre os dois pontos. */
  readonly spanDays: number;
  /** A janela pedida coube no histórico? `false` quando o histórico é mais curto e se usou o ponto mais antigo. */
  readonly fullWindow: boolean;
}

/**
 * "−0,7 kg em 14 dias": a tendência do último ponto menos a do último ponto que tem pelo menos `days` dias de idade. Se o
 * histórico é mais curto que a janela, usa o ponto mais antigo e diz isso (`fullWindow: false`, com os dias reais em
 * `spanDays`), para a tela nunca escrever "14 dias" sobre uma conta de 5. Devolve `null` com menos de dois pontos.
 */
export function trendDelta(entries: readonly WeightSample[], days: number): TrendDelta | null {
  if (!Number.isInteger(days) || days <= 0) return null;
  const points = weightTrend(entries);
  if (points.length < 2) return null;

  const latest = points[points.length - 1];
  const cutoff = addDaysToKey(latest.date, -days) as string;
  let reference: TrendPoint | undefined;
  for (const point of points) {
    if (point.date <= cutoff) reference = point;
  }

  const fullWindow = reference !== undefined;
  const from = reference ?? points[0];
  if (from === latest) return null;
  return {
    deltaKg: latest.trendKg - from.trendKg,
    spanDays: daysBetween(from.date, latest.date) as number,
    fullWindow,
  };
}
