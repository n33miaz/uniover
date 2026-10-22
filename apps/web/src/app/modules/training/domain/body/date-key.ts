/**
 * Datas do corpo como texto `AAAA-MM-DD` (o dia local do aparelho, sem hora nem fuso). Funções puras: a aritmética é feita
 * em UTC sobre o calendário, então o fuso da máquina nunca entra na conta e o teste vale em qualquer computador.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface DateParts {
  readonly year: number;
  /** De 1 a 12. */
  readonly month: number;
  readonly day: number;
}

/** Lê `AAAA-MM-DD`. Devolve `null` para texto fora do formato ou dia que não existe (31/02). */
export function parseDateKey(key: string): DateParts | null {
  const match = DATE_KEY.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC aceita ano de dois dígitos como 19xx: conferir que voltou o mesmo dia.
  check.setUTCFullYear(year);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function toUtcMs(parts: DateParts): number {
  const date = new Date(Date.UTC(2000, parts.month - 1, parts.day));
  date.setUTCFullYear(parts.year);
  return date.getTime();
}

/** Dias inteiros de `from` até `to` (negativo se `to` é anterior). `null` se alguma das datas é inválida. */
export function daysBetween(from: string, to: string): number | null {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (a === null || b === null) return null;
  return Math.round((toUtcMs(b) - toUtcMs(a)) / MS_PER_DAY);
}

/** A data `days` dias depois (ou antes, se negativo). `null` se a data é inválida. */
export function addDaysToKey(key: string, days: number): string | null {
  const parts = parseDateKey(key);
  if (parts === null) return null;
  const moved = new Date(toUtcMs(parts) + days * MS_PER_DAY);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}
