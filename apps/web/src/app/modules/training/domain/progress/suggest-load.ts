import { isRecordSetType } from './one-rep-max';

/**
 * Sugestão de carga para a próxima vez que o exercício for feito: **dupla progressão**. É uma regra nossa, não de
 * estudo: não achamos estudo que mostre que supera outros esquemas (só textos de blogs e de apps), e o dono aceita ou
 * ignora a sugestão.
 *
 * - Se **todas** as séries de trabalho da última vez chegaram ao topo da faixa da rotina e nenhuma foi tão dura a ponto
 *   de sobrar menos de duas repetições de reserva, sobe **um salto de carga** do exercício e o alvo volta ao piso.
 * - Se alguma série ficou abaixo do piso da faixa, **mantém** a carga: o app nunca reduz sozinho (quem baixa a carga é
 *   o dono) e diz o motivo.
 * - Se as repetições ficaram dentro da faixa mas nem todas no topo, mantém a carga e o alvo é a faixa inteira.
 * - Sem histórico, não há sugestão.
 */

/** O que a sugestão precisa saber de uma série da última vez. */
export interface SuggestionSet {
  readonly setType: string;
  readonly weightKg: number | null;
  readonly reps: number | null;
  /** Repetições em reserva informadas (0 a 10), se houver. */
  readonly rir?: number | null;
  /** Esforço percebido informado (1 a 10, de meio em meio ponto), se houver; 10 = nenhuma repetição de reserva. */
  readonly rpe?: number | null;
}

/**
 * Por que a sugestão é essa (código estável: a tela traduz).
 * - `top-of-range`: todas no topo da faixa: sobe a carga.
 * - `below-floor`: alguma série abaixo do piso: mantém a carga.
 * - `rir-too-high`: no topo, mas sobrava mais de duas repetições de reserva: mantém a carga.
 * - `within-range`: dentro da faixa, ainda não no topo: mantém a carga e busca mais repetições.
 * - `no-history`: sem série de trabalho anterior: sem sugestão de carga.
 */
export type SuggestionReason =
  'top-of-range' | 'below-floor' | 'rir-too-high' | 'within-range' | 'no-history';

export interface LoadSuggestion {
  /** Carga sugerida em kg; `null` quando não há histórico. */
  readonly weightKg: number | null;
  /** Faixa de repetições alvo. */
  readonly repsFrom: number;
  readonly repsTo: number;
  readonly reason: SuggestionReason;
}

export interface SuggestNextLoadInput {
  /** As séries da última vez que o exercício foi feito (aquecimento e drop são ignorados aqui). */
  readonly lastSets: readonly SuggestionSet[];
  readonly repMin: number;
  readonly repMax: number;
  /** Salto de carga do exercício (kg); 0 quando a carga não sobe (peso do corpo). */
  readonly stepKg: number;
}

/** Acima disto a série ainda tinha folga demais para contar como "topo da faixa" suado. */
const MAX_RIR_TO_RAISE = 2;

/** Quantas repetições acima do piso formam o alvo logo depois de subir a carga (ex.: faixa 6–10 → 6–8). */
const REPS_WINDOW_AFTER_RAISE = 2;

/**
 * Repetições de reserva da série: o RIR informado, ou `10 − RPE`, ou `null` se nenhum foi informado. A escala que liga
 * esforço percebido a repetições em reserva (RPE 10 = nenhuma de reserva, 9 = uma, e assim por diante) é de Zourdos e
 * outros (2016, JSCR 30(1):267-275; só o resumo foi lido), testada só no agachamento e com amostra pequena. Os meios
 * pontos (8,5, 9,5) vêm de um resumo secundário.
 */
export function reserveReps(set: SuggestionSet): number | null {
  if (set.rir !== undefined && set.rir !== null) return set.rir;
  if (set.rpe !== undefined && set.rpe !== null) return 10 - set.rpe;
  return null;
}

const toHundredths = (kg: number) => Math.round(kg * 100);

/** Arredonda a carga ao múltiplo do salto (na conta de centésimos, para 42,5 não virar 42,4999). */
function roundToStep(weightKg: number, stepKg: number): number {
  const step = toHundredths(stepKg);
  const cents = toHundredths(weightKg);
  return (Math.round(cents / step) * step) / 100;
}

export function suggestNextLoad(input: SuggestNextLoadInput): LoadSuggestion {
  const { repMin, repMax, stepKg } = input;
  const work = input.lastSets.filter(
    (set) =>
      isRecordSetType(set.setType) &&
      set.weightKg !== null &&
      set.weightKg >= 0 &&
      set.reps !== null,
  );
  if (work.length === 0) {
    return { weightKg: null, repsFrom: repMin, repsTo: repMax, reason: 'no-history' };
  }

  const currentKg = Math.max(...work.map((set) => set.weightKg as number));
  const keep = (reason: SuggestionReason): LoadSuggestion => ({
    weightKg: currentKg,
    repsFrom: repMin,
    repsTo: repMax,
    reason,
  });

  if (work.some((set) => (set.reps as number) < repMin)) return keep('below-floor');
  if (!work.every((set) => (set.reps as number) >= repMax)) return keep('within-range');
  if (work.some((set) => (reserveReps(set) ?? 0) > MAX_RIR_TO_RAISE)) return keep('rir-too-high');

  // Sem salto (peso do corpo) a carga não sobe: fica a mesma e o alvo é a faixa inteira.
  if (!(stepKg > 0)) return keep('top-of-range');

  return {
    weightKg: roundToStep(currentKg + stepKg, stepKg),
    repsFrom: repMin,
    repsTo: Math.min(repMax, repMin + REPS_WINDOW_AFTER_RAISE),
    reason: 'top-of-range',
  };
}
