import { APP_CONFIG } from '../../../../core/config/app-config';

export const CALENDAR_ENTRIES_PATH = `${APP_CONFIG.apiBase}/v1/training/calendar-entries`;

export function calendarEntryPath(dayKey: string): string {
  return `${CALENDAR_ENTRIES_PATH}/${encodeURIComponent(dayKey)}`;
}
