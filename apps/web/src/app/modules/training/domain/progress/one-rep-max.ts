/**
 * Estimativa de 1RM (a maior carga que se levantaria uma única vez) a partir de uma série. Funções puras.
 *
 * É sempre uma **estimativa** e serve de tendência de progresso, nunca de carga para tentar um máximo. As fórmulas só
 * estimam: no estudo de LeSuer e outros (1997, JSCR 11(4):211-213), que comparou sete equações, todas subestimaram o
 * levantamento terra (descrito em um preprint, não no artigo), e qual fórmula acerta mais depende do exercício, da faixa de repetições e da
 * pessoa.
 *
 * Duas fórmulas (a escolhida vem como parâmetro e a tela mostra qual está em uso):
 * - Epley: `carga × (1 + repetições / 30)`, o padrão.
 * - Brzycki: `carga × 36 / (37 − repetições)`. A conta explode perto de 37 repetições (o denominador zera).
 *
 * Fonte secundária (uma página de comparação de fórmulas de e1RM, fitnessvolt.com/rpe-training/compare/e1rm-formulas, não
 * conferida em estudo primário): o Epley tende a superestimar acima de 10 repetições e o Brzycki costuma ser tratado como
 * melhor de 1 a 10. Por isso nada acima de 10 repetições é estimado.
 *
 * Lombardi **não** está aqui: a constante dela não foi confirmada por fonte confiável.
 */

export const ONE_RM_FORMULAS = ['epley', 'brzycki'] as const;
export type OneRmFormula = (typeof ONE_RM_FORMULAS)[number];

export const DEFAULT_ONE_RM_FORMULA: OneRmFormula = 'epley';

/** Só séries de 1 a este número de repetições entram na estimativa. */
export const ONE_RM_MAX_REPS = 10;

/** O que a estimativa precisa saber de uma série. */
export interface EstimableSet {
  readonly setType: string;
  readonly weightKg: number | null;
  readonly reps: number | null;
}

/**
 * Tipos de série que contam para carga máxima, 1RM e recordes: as de trabalho e as levadas à falha. Aquecimento não
 * conta (carga leve de propósito) e a série "drop" também não (a carga é reduzida de propósito, depois da falha).
 */
export function isRecordSetType(setType: string): boolean {
  return setType === 'work' || setType === 'failure';
}

/** A série tem carga positiva e ao menos uma repetição, e é de um tipo que conta para recorde? */
export function isLoadSet(set: EstimableSet): boolean {
  return (
    isRecordSetType(set.setType) &&
    set.weightKg !== null &&
    Number.isFinite(set.weightKg) &&
    set.weightKg > 0 &&
    set.reps !== null &&
    Number.isInteger(set.reps) &&
    set.reps >= 1
  );
}

/** A série entra na estimativa de 1RM? Carga positiva, de 1 a 10 repetições e série de trabalho ou falha. */
export function isEstimable(set: EstimableSet): boolean {
  return isLoadSet(set) && (set.reps as number) <= ONE_RM_MAX_REPS;
}

/**
 * 1RM estimado em kg, sem arredondar (quem mostra arredonda). `null` fora das regras: carga que não é positiva ou
 * repetições que não sejam um inteiro de 1 a 10.
 */
export function estimate1RM(
  weightKg: number,
  reps: number,
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): number | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!Number.isInteger(reps) || reps < 1 || reps > ONE_RM_MAX_REPS) return null;
  return formula === 'brzycki' ? (weightKg * 36) / (37 - reps) : weightKg * (1 + reps / 30);
}

/** 1RM estimado de uma série, ou `null` se ela não é estimável (ver `isEstimable`). */
export function estimateSet1RM(
  set: EstimableSet,
  formula: OneRmFormula = DEFAULT_ONE_RM_FORMULA,
): number | null {
  return isEstimable(set) ? estimate1RM(set.weightKg as number, set.reps as number, formula) : null;
}
