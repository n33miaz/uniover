import { TestBed } from '@angular/core/testing';
import { setupTraining } from '../sync/training-test-kit';
import { type CalendarEntryDto, toLocalCalendarEntry } from './calendar-entry';
import { CalendarEntryRepository } from './calendar-entry-repository';

const dto = (overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto => ({
  id: '0199e000-0000-7000-8000-000000000001',
  dayKey: '2026-10-27',
  absent: false,
  note: 'Academia cheia',
  updatedAt: '2026-10-27T12:00:00.0000000+00:00',
  clientUpdatedAt: '2026-10-27T12:00:00.0000000+00:00',
  deleted: false,
  ...overrides,
});

describe('CalendarEntryRepository', () => {
  it('keeps a note attached to its civil day and sends it through the offline queue', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await repository.save('2026-10-27', { absent: false, note: 'Academia cheia' });
    expect((await repository.get('2026-10-27'))?.note).toBe('Academia cheia');
    expect((await kit.db.outbox.toArray())[0]).toMatchObject({
      url: expect.stringContaining('2026-10-27'),
    });
  });

  it('reads only the live entries of a date range', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await repository.save('2026-10-26', { absent: true, note: '' });
    await repository.save('2026-10-28', { absent: false, note: 'Ombro doendo' });
    await repository.save('2026-11-05', { absent: true, note: '' });

    const range = await repository.between('2026-10-25', '2026-10-31');
    expect(range.map((entry) => entry.dayKey)).toEqual(['2026-10-26', '2026-10-28']);
  });

  it('turns an emptied entry into a tombstone that is queued, never a physical delete', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await repository.save('2026-10-27', { absent: true, note: 'Viagem' });
    await repository.save('2026-10-27', { absent: false, note: '' });

    expect(await repository.get('2026-10-27')).toBeUndefined();
    const row = await kit.trainingDb.calendarEntries.get('2026-10-27');
    expect(row?.deletedAt).not.toBeNull();
    const queued = await kit.db.outbox.toArray();
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({
      method: 'PUT',
      body: { deleted: true, absent: false, note: null },
    });
  });

  it('keeps both a note and an absence when they are saved at almost the same time', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await Promise.all([
      repository.update('2026-10-27', { note: 'Viagem curta' }),
      repository.update('2026-10-27', { absent: true }),
    ]);
    expect(await repository.get('2026-10-27')).toMatchObject({
      absent: true,
      note: 'Viagem curta',
    });

    await Promise.all([
      repository.update('2026-10-27', { absent: false }),
      repository.update('2026-10-27', { note: 'Voltei' }),
    ]);
    expect(await repository.get('2026-10-27')).toMatchObject({ absent: false, note: 'Voltei' });
  });

  it('keeps the note when the absence is undone', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await repository.save('2026-10-27', { absent: true, note: 'Viagem' });
    await repository.save('2026-10-27', { absent: false, note: 'Viagem' });

    expect(await repository.get('2026-10-27')).toMatchObject({ absent: false, note: 'Viagem' });
  });

  it('merges the server copy by last write wins on the device clock, tombstones included', async () => {
    const kit = setupTraining();
    kit.pause();
    const repository = TestBed.inject(CalendarEntryRepository);
    await repository.applyRemote([toLocalCalendarEntry(dto())!]);
    expect((await repository.get('2026-10-27'))?.note).toBe('Academia cheia');

    // Uma cópia mais antiga do servidor não desfaz a escrita local.
    await repository.applyRemote([
      toLocalCalendarEntry(
        dto({ note: 'Antiga', clientUpdatedAt: '2026-10-27T11:00:00.0000000+00:00' }),
      )!,
    ]);
    expect((await repository.get('2026-10-27'))?.note).toBe('Academia cheia');

    // A lápide mais nova de outro aparelho apaga a nota aqui também.
    await repository.applyRemote([
      toLocalCalendarEntry(
        dto({ deleted: true, note: null, clientUpdatedAt: '2026-10-27T13:00:00.0000000+00:00' }),
      )!,
    ]);
    expect(await repository.get('2026-10-27')).toBeUndefined();
  });
});
