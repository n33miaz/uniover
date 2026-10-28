import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { CALENDAR_ENTRIES_PATH } from './calendar-api';
import {
  type CalendarEntryDto,
  type LocalCalendarEntry,
  toLocalCalendarEntry,
} from './calendar-entry';
import { CalendarEntryRepository } from './calendar-entry-repository';

@Injectable()
export class CalendarEntriesResourceSync implements ResourceSync<CalendarEntryDto> {
  private readonly repository = inject(CalendarEntryRepository);
  readonly resource = 'calendarEntries';
  readonly path = CALENDAR_ENTRIES_PATH;
  merge(items: readonly CalendarEntryDto[]): Promise<void> {
    return this.repository.applyRemote(
      items
        .map(toLocalCalendarEntry)
        .filter((entry): entry is LocalCalendarEntry => entry !== null),
    );
  }
}

export function provideCalendarEntriesData(): Provider[] {
  return [CalendarEntryRepository, provideResourceSync(CalendarEntriesResourceSync)];
}
