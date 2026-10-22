import {
  type CivilDate,
  addDays,
  civilDateOf,
  dateKeyOf,
  startOfDay,
  weekdayIndex,
} from '../domain/progress/calendar';

export interface CalendarDay extends CivilDate {
  readonly key: string;
}

export interface CalendarWeek {
  readonly days: readonly CalendarDay[];
  readonly start: number;
  readonly end: number;
}

export interface CalendarMonth {
  readonly year: number;
  readonly month: number;
}

export function calendarDay(date: CivilDate): CalendarDay {
  return { ...date, key: dateKeyOf(date) };
}

/** A semana da tela começa no domingo, inclusive quando atravessa mês ou horário de verão. */
export function sundayWeek(now: number, offset: number, timeZone: string): CalendarWeek {
  const today = civilDateOf(now, timeZone);
  const daysSinceSunday = (weekdayIndex(today) + 1) % 7;
  const sunday = addDays(today, -daysSinceSunday + offset * 7);
  const days = Array.from({ length: 7 }, (_, index) => calendarDay(addDays(sunday, index)));
  return {
    days,
    start: startOfDay(sunday, timeZone),
    end: startOfDay(addDays(sunday, 7), timeZone),
  };
}

export function moveMonth(month: CalendarMonth, offset: number): CalendarMonth {
  const date = new Date(Date.UTC(month.year, month.month - 1 + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

/** Grade de domingo a sábado; os vazios preservam a coluna do primeiro dia. */
export function sundayMonth(month: CalendarMonth): readonly (CalendarDay | null)[] {
  const first = { ...month, day: 1 };
  const lead = (weekdayIndex(first) + 1) % 7;
  const count = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const days: (CalendarDay | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, index) => calendarDay({ ...month, day: index + 1 })),
  ];
  while (days.length % 7 !== 0) days.push(null);
  return days;
}
