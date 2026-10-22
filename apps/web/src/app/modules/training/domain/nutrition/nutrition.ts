/** Cálculos de alimentos sem dependências de tela, banco ou rede. */

export interface NutritionValues {
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbG: number;
  readonly fatG: number;
}

export interface NutritionEntry extends NutritionValues {
  readonly id: string;
  readonly mealType: string;
}

/** Escala nutrientes por 100 g para uma porção; calorias ficam inteiras e macros têm duas casas. */
export function scale(per100g: NutritionValues, grams: number): NutritionValues {
  if (!Number.isFinite(grams) || grams < 0) throw new RangeError('grams');
  const factor = grams / 100;
  return {
    kcal: Math.round(per100g.kcal * factor),
    proteinG: round(per100g.proteinG * factor),
    carbG: round(per100g.carbG * factor),
    fatG: round(per100g.fatG * factor),
  };
}

export function mealTotals(entries: readonly NutritionEntry[]): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const entry of entries)
    totals[entry.mealType] = Math.round((totals[entry.mealType] ?? 0) + entry.kcal);
  return totals;
}

export function dayTotals(entries: readonly NutritionEntry[]): NutritionValues {
  return entries.reduce(
    (total, entry) => ({
      kcal: Math.round(total.kcal + entry.kcal),
      proteinG: round(total.proteinG + entry.proteinG),
      carbG: round(total.carbG + entry.carbG),
      fatG: round(total.fatG + entry.fatG),
    }),
    { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
  );
}

/** Retorna o saldo inteiro: positivo = faltam calorias; negativo = passou da meta. */
export function remaining(target: number, eaten: number): number {
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(eaten) || eaten < 0) {
    throw new RangeError('calories');
  }
  return Math.round(target - eaten);
}

/** Chave do dia civil em um fuso IANA, sem depender do fuso configurado no servidor. */
export function dayKey(date: Date | number, timeZone: string): string {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new RangeError('date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('timeZone');
  return `${year}-${month}-${day}`;
}

function round(value: number): number {
  const scaled = value * 100;
  return Math.round(scaled + Number.EPSILON * Math.abs(scaled)) / 100;
}
