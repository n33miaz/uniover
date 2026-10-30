import {
  type WeekRange,
  addDays,
  civilDateOf,
  startOfDay,
  weekRange,
  weekdayIndex,
} from '../domain/progress/calendar';

/**
 * A semana (domingo a sábado) que fica `offset` semanas depois (positivo) ou antes (negativo) da semana de `now`. Anda
 * pelo calendário, nunca por múltiplos de 168 horas: a semana que atravessa uma mudança de horário tem 167 ou 169.
 */
export function weekAt(now: number, offset: number, timeZone: string): WeekRange {
  const current = weekRange(now, timeZone);
  if (offset === 0) return current;
  const sunday = addDays(civilDateOf(current.start, timeZone), offset * 7);
  return weekRange(startOfDay(sunday, timeZone), timeZone);
}

export interface YearMonth {
  readonly year: number;
  /** De 1 a 12. */
  readonly month: number;
}

/** O mês `delta` meses depois (positivo) ou antes (negativo), com a virada de ano. */
export function shiftMonth(base: YearMonth, delta: number): YearMonth {
  const index = base.year * 12 + (base.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * A grade do mês em semanas de domingo a sábado: cada célula é o dia do mês, ou `null` nos vazios do começo e do fim
 * (os dias de outro mês não aparecem: o app não tem o que mostrar neles).
 */
export function monthGrid(year: number, month: number, daysInMonth: number): (number | null)[][] {
  const lead = weekdayIndex({ year, month, day: 1 });
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) weeks.push(cells.slice(start, start + 7));
  return weeks;
}
