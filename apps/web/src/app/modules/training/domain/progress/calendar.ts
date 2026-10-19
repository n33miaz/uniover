/**
 * Datas do progresso no fuso do aparelho. Funções puras: o fuso entra como parâmetro (nada lê o fuso da máquina), então
 * o teste vale em qualquer computador. Todo dia local sai de `Intl.DateTimeFormat` com o fuso pedido, nunca dos
 * `getDate`/`getDay` do `Date`, que seguem o fuso de quem roda. A semana vai de **segunda a domingo**.
 */

/** Dia do calendário, sem hora nem fuso. */
export interface CivilDate {
  readonly year: number;
  /** De 1 a 12. */
  readonly month: number;
  readonly day: number;
}

/** Uma semana: do início da segunda (inclusive) ao início da segunda seguinte (exclusive), em milissegundos. */
export interface WeekRange {
  readonly start: number;
  readonly end: number;
  /** Segunda e domingo da semana, como `AAAA-MM-DD`. */
  readonly startKey: string;
  readonly endKey: string;
}

export type ProgressPeriod = '8w' | '6m' | 'all';

/** Fuso do aparelho (padrão para quem não passa um). */
export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function partsAt(ms: number, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

/** Quanto o relógio do fuso está à frente do UTC naquele instante (ms). */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsAt(ms, timeZone);
  const asUtc = Date.UTC(p['year'], p['month'] - 1, p['day'], p['hour'], p['minute'], p['second']);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** O dia local do instante, no fuso pedido. */
export function civilDateOf(ms: number, timeZone: string): CivilDate {
  const p = partsAt(ms, timeZone);
  return { year: p['year'], month: p['month'], day: p['day'] };
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

export function dateKeyOf(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** O dia local do instante como `AAAA-MM-DD`. */
export function dateKey(ms: number, timeZone: string): string {
  return dateKeyOf(civilDateOf(ms, timeZone));
}

/** Soma dias no calendário (sem fuso: dia é dia). */
export function addDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/** 0 = segunda ... 6 = domingo. */
export function weekdayIndex(date: CivilDate): number {
  const sunday0 = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (sunday0 + 6) % 7;
}

/**
 * O instante em que o dia local começa (meia-noite do fuso). O deslocamento é medido no próprio instante, então vale
 * nos dias de mudança de horário: o dia tem 23 ou 25 horas e a conta não erra. Se a meia-noite não existe (o relógio
 * pulou), vale o primeiro instante do dia.
 */
export function startOfDay(date: CivilDate, timeZone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  // Meia-noite que o relógio pulou: a segunda estimativa cai na noite anterior e a primeira já é o início do dia.
  return dateKeyOf(civilDateOf(second, timeZone)) === dateKeyOf(date) ? second : first;
}

/** A semana (segunda a domingo) que contém o instante, no fuso pedido. */
export function weekRange(ms: number, timeZone: string): WeekRange {
  const today = civilDateOf(ms, timeZone);
  const monday = addDays(today, -weekdayIndex(today));
  const nextMonday = addDays(monday, 7);
  return {
    start: startOfDay(monday, timeZone),
    end: startOfDay(nextMonday, timeZone),
    startKey: dateKeyOf(monday),
    endKey: dateKeyOf(addDays(monday, 6)),
  };
}

/** Mês do calendário (de 1 a 12) com os seus limites em milissegundos. */
export interface MonthRange {
  readonly start: number;
  readonly end: number;
  readonly daysInMonth: number;
}

export function monthRange(year: number, month: number, timeZone: string): MonthRange {
  const first: CivilDate = { year, month, day: 1 };
  const next: CivilDate =
    month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: startOfDay(first, timeZone), end: startOfDay(next, timeZone), daysInMonth };
}

/**
 * Janela de tempo de um período do gráfico. `8w` = os últimos 56 dias corridos; `6m` = seis meses de calendário para
 * trás (na conta do UTC, sem fuso: a diferença de algumas horas na borda não muda o desenho do gráfico; o dia do mês
 * é limitado ao último do mês de destino); `all` = sem início.
 */
export function periodRange(
  period: ProgressPeriod,
  now: number,
): { readonly from: number | null; readonly to: number } {
  if (period === 'all') return { from: null, to: now };
  if (period === '8w') return { from: now - 56 * 24 * 60 * 60 * 1000, to: now };
  const at = new Date(now);
  const target = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 6 + 1, 0));
  const day = Math.min(at.getUTCDate(), target.getUTCDate());
  const from = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    day,
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
  return { from, to: now };
}
