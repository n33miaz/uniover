/**
 * Percentual de gordura pela fórmula da Marinha dos EUA (Hodgdon e Beckett, 1984). Função pura.
 *
 * As equações são em POLEGADAS, com logaritmo de base 10; o app guarda centímetros, então a conversão (`÷ 2,54`) é feita
 * AQUI, dentro do logaritmo, e nenhuma constante métrica foi inventada (a conferência das constantes e o registro das
 * fontes estão em `body-features.ts`):
 *
 *   homem:  %G = 86,010 × log10(abdômen − pescoço) − 70,041 × log10(altura) + 36,76
 *   mulher: %G = 163,205 × log10(cintura + quadril − pescoço) − 97,684 × log10(altura) − 78,387
 *
 * ONDE MEDIR (a tela deve dizer): no homem, o "abdômen" é a circunferência na altura do umbigo; na mulher, a cintura é o
 * ponto mais estreito do tronco e o quadril o ponto mais largo das nádegas; o pescoço, logo abaixo da laringe. É a medida
 * `waistCm` do app nos dois casos.
 *
 * É estimativa de população militar dos EUA, com erro de poucos pontos para cada pessoa: sempre com aviso, nunca como
 * diagnóstico. Abaixo de 18 anos devolve `null` (o app é pessoal e não atende menores).
 */

import { NAVY_BODY_FAT_ENABLED } from './body-features';
import { ADULT_AGE_YEARS, BODY_LIMITS, type BodySex } from './body-limits';
import { round1 } from './rounding';

const CM_PER_INCH = 2.54;

export interface NavyBodyFatInput {
  readonly sex: BodySex;
  readonly heightCm: number;
  readonly neckCm: number;
  /** Homem: abdômen na altura do umbigo. Mulher: cintura no ponto mais estreito. */
  readonly waistCm: number;
  /** Só a mulher usa o quadril. */
  readonly hipCm?: number | null;
  /** Idade em anos completos (`ageYears`). */
  readonly ageYears: number;
}

export interface NavyBodyFatOptions {
  /** Troca o interruptor de recurso (os testes). O padrão é `NAVY_BODY_FAT_ENABLED`. */
  readonly enabled?: boolean;
}

const isPositive = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Percentual de gordura, com 1 casa, ou `null` quando não dá para calcular: recurso desligado, menor de 18 anos, medida
 * faltando, circunferência que zera ou inverte a diferença (o logaritmo de número não positivo), ou resultado fora da faixa que
 * a API aceita (2 a 70 %), que seria um número sem sentido para essas medidas.
 */
export function navyBodyFat(
  input: NavyBodyFatInput,
  options: NavyBodyFatOptions = {},
): number | null {
  if (!(options.enabled ?? NAVY_BODY_FAT_ENABLED)) return null;
  if (!Number.isFinite(input.ageYears) || input.ageYears < ADULT_AGE_YEARS) return null;
  if (!isPositive(input.heightCm) || !isPositive(input.neckCm) || !isPositive(input.waistCm))
    return null;

  let value: number;
  if (input.sex === 'male') {
    const girth = input.waistCm - input.neckCm;
    if (girth <= 0) return null;
    value =
      86.01 * Math.log10(girth / CM_PER_INCH) -
      70.041 * Math.log10(input.heightCm / CM_PER_INCH) +
      36.76;
  } else {
    if (!isPositive(input.hipCm)) return null;
    const girth = input.waistCm + input.hipCm - input.neckCm;
    if (girth <= 0) return null;
    value =
      163.205 * Math.log10(girth / CM_PER_INCH) -
      97.684 * Math.log10(input.heightCm / CM_PER_INCH) -
      78.387;
  }

  const rounded = round1(value);
  const { min, max } = BODY_LIMITS.bodyFatPct;
  return Number.isFinite(rounded) && rounded >= min && rounded <= max ? rounded : null;
}
