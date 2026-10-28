import type { components } from '../../../../core/api/generated/schema';
import { newestWins } from '../sync/merge';

/** Anotação ou ausência de um dia; a chave natural é a própria data civil. */
export interface LocalCalendarEntry {
  readonly id: string;
  readonly dayKey: string;
  readonly absent: boolean;
  readonly note: string;
  readonly updatedAt: number;
  readonly clientUpdatedAt: number;
  readonly deletedAt: number | null;
}

/** O dia como a API o entrega (tipo gerado do OpenAPI). */
export type CalendarEntryDto = components['schemas']['CalendarEntryResponse'];

/** O corpo do `PUT` do dia (tipo gerado do OpenAPI). */
export type CalendarEntryBody = components['schemas']['CalendarEntryRequest'];

const stamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function toLocalCalendarEntry(dto: CalendarEntryDto): LocalCalendarEntry | null {
  const updatedAt = stamp(dto.updatedAt);
  const clientUpdatedAt = stamp(dto.clientUpdatedAt);
  if (updatedAt === null || clientUpdatedAt === null) return null;
  return {
    // A data é a chave natural no aparelho; o UUID do servidor só ordena o cursor.
    id: dto.dayKey,
    dayKey: dto.dayKey,
    absent: dto.deleted ? false : dto.absent,
    note: dto.deleted ? '' : (dto.note ?? ''),
    updatedAt,
    clientUpdatedAt,
    deletedAt: dto.deleted ? updatedAt : null,
  };
}

export function calendarEntryBody(entry: LocalCalendarEntry): CalendarEntryBody {
  return {
    absent: entry.deletedAt === null && entry.absent,
    note: entry.deletedAt === null && entry.note.trim() !== '' ? entry.note.trim() : null,
    clientUpdatedAt: new Date(entry.clientUpdatedAt).toISOString(),
    deleted: entry.deletedAt !== null,
  };
}

export function resolveCalendarEntry(
  local: LocalCalendarEntry,
  remote: LocalCalendarEntry,
): LocalCalendarEntry {
  return newestWins(local, remote);
}
