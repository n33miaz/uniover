import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import { calendarEntryPath } from './calendar-api';
import { type LocalCalendarEntry, calendarEntryBody, resolveCalendarEntry } from './calendar-entry';

export type CalendarEntryWrite =
  | { readonly status: 'saved'; readonly entry: LocalCalendarEntry }
  | { readonly status: 'storage-full' };

/** Leitura e escrita local-first das ausências e notas diárias da conta. */
@Injectable()
export class CalendarEntryRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  async get(dayKey: string): Promise<LocalCalendarEntry | undefined> {
    const row = await this.db.calendarEntries.get(dayKey);
    return row?.deletedAt === null ? row : undefined;
  }

  async between(start: string, end: string): Promise<LocalCalendarEntry[]> {
    return (
      await this.db.calendarEntries.where('dayKey').between(start, end, true, true).toArray()
    ).filter((entry) => entry.deletedAt === null);
  }

  async save(
    dayKey: string,
    change: { absent: boolean; note: string },
  ): Promise<CalendarEntryWrite> {
    const previous = await this.db.calendarEntries.get(dayKey);
    const stamp = Math.max(this.runtime.now(), (previous?.clientUpdatedAt ?? 0) + 1);
    const note = change.note.trim().slice(0, 280);
    const entry: LocalCalendarEntry = {
      id: dayKey,
      dayKey,
      absent: change.absent,
      note,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: change.absent || note !== '' ? null : stamp,
    };
    await this.db.calendarEntries.put(entry);
    this.touch();
    try {
      await this.queue.enqueue({
        method: 'PUT',
        module: 'training',
        url: calendarEntryPath(dayKey),
        body: calendarEntryBody(entry),
      });
      return { status: 'saved', entry };
    } catch (error) {
      const current = await this.db.calendarEntries.get(dayKey);
      if (current?.clientUpdatedAt === entry.clientUpdatedAt) {
        if (previous) await this.db.calendarEntries.put(previous);
        else await this.db.calendarEntries.delete(dayKey);
        this.touch();
      }
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  async applyRemote(entries: readonly LocalCalendarEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.transaction('rw', this.db.calendarEntries, async () => {
      const local = new Map<string, LocalCalendarEntry>();
      for (const entry of await this.db.calendarEntries.bulkGet(entries.map((entry) => entry.id))) {
        if (entry) local.set(entry.id, entry);
      }
      const writes = mergeById(local, entries, resolveCalendarEntry);
      if (writes.length) await this.db.calendarEntries.bulkPut(writes);
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
