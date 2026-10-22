/**
 * Idade, taxa basal e meta de calorias. Funções puras: nada de Angular, banco ou rede. Tudo é ESTIMATIVA (a tela mostra a
 * conta e os avisos de saúde).
 *
 * Taxa basal (Mifflin-St Jeor, 1990): `10 × peso(kg) + 6,25 × altura(cm) − 5 × idade + 5` (homem) ou `− 161` (mulher). O
 * resumo do artigo original não foi lido por quem pesquisou; os dados vieram de páginas que o citam. Os fatores de atividade
 * (1,2 a 1,9) são convenção popular, NÃO do artigo, e erram para quem treina: o app usa 1,55 como padrão editável e mostra a
 * conta.
 *
 * Quilocalorias são sempre inteiras (é o que a tela mostra): a taxa basal já sai arredondada, e é ela que a meta compara, para
 * "a meta nunca fica abaixo da taxa basal" valer sobre o número que o dono vê.
 */

import { parseDateKey } from './date-key';
import { ADULT_AGE_YEARS, type BodySex } from './body-limits';
import { roundKcal } from './rounding';

/**
 * Anos completos entre o nascimento e o dia `asOf` (ambos `AAAA-MM-DD`). Nasceu em 29/02: no ano sem 29/02 o aniversário
 * conta a partir de 1.º/03. `null` se alguma data é inválida ou o nascimento é depois de `asOf`.
 */
export function ageYears(birthDate: string, asOf: string): number | null {
  const birth = parseDateKey(birthDate);
  const now = parseDateKey(asOf);
  if (birth === null || now === null) return null;

  let years = now.year - birth.year;
  if (now.month < birth.month || (now.month === birth.month && now.day < birth.day)) years -= 1;
  return years < 0 ? null : years;
}

export interface BasalRateInput {
  readonly weightKg: number;
  readonly heightCm: number;
  /** Idade em anos completos. */
  readonly ageYears: number;
  readonly sex: BodySex;
}

/**
 * Taxa basal em kcal inteiras, ou `null` quando não dá para estimar: menor de 18 anos (o app é pessoal e não atende
 * menores) ou dado que não é número positivo.
 */
export function mifflinStJeor(input: BasalRateInput): number | null {
  const { weightKg, heightCm, ageYears: age, sex } = input;
  if (![weightKg, heightCm, age].every((value) => Number.isFinite(value))) return null;
  if (weightKg <= 0 || heightCm <= 0 || age < ADULT_AGE_YEARS) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return roundKcal(base + (sex === 'male' ? 5 : -161));
}

/** Gasto diário estimado: taxa basal vezes o fator de atividade, em kcal inteiras. */
export function tdee(bmr: number, activityFactor: number): number {
  return roundKcal(bmr * activityFactor);
}

export interface CalorieTarget {
  /** A meta a usar: a escolhida, ou a taxa basal quando a escolhida ficava abaixo dela. */
  readonly target: number;
  /** A meta escolhida era menor que a taxa basal estimada: a tela trava e avisa. */
  readonly belowBmr: boolean;
}

/**
 * Meta de calorias: a que o dono escolheu, mas NUNCA abaixo da taxa basal estimada (decisão nossa; nenhuma fonte lida
 * define esse número). Abaixo dela devolve a própria taxa basal e `belowBmr: true`. Escolha que não é número vale como
 * "sem escolha": devolve a taxa basal sem o aviso (não há o que travar).
 */
export function calorieTarget({ chosen, bmr }: { chosen: number; bmr: number }): CalorieTarget {
  if (!Number.isFinite(chosen)) return { target: bmr, belowBmr: false };
  const rounded = roundKcal(chosen);
  return rounded < bmr ? { target: bmr, belowBmr: true } : { target: rounded, belowBmr: false };
}
