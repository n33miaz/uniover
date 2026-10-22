import { TestBed } from '@angular/core/testing';
import { ExportService } from '../export/export-service';
import { setupBody } from './body-data-test-kit';

describe('body export sections', () => {
  it('exports the live measurements oldest first and the profile, with the clock as an ISO text', async () => {
    const t = setupBody();
    const first = await t.repository.saveEntry({
      measuredOn: '2025-10-05',
      weightKg: 82.4,
      bodyFatPct: 16.9,
      fatMethod: 'navy',
      waistCm: 86,
      note: 'de manhã',
    });
    await t.repository.saveEntry({ measuredOn: '2025-09-20', weightKg: 83 });
    const gone = await t.repository.saveEntry({
      measuredOn: '2025-10-01',
      weightKg: 99,
      note: 'apagada',
    });
    if (gone.status === 'saved') await t.repository.softDeleteEntry(gone.entry.id);
    await t.profiles.save({
      heightCm: 180,
      birthDate: '1995-06-15',
      sex: 'male',
      activityFactor: 1.55,
    });

    const document = await TestBed.inject(ExportService).buildJson();
    const sections = document.sections as Record<string, unknown[]>;

    expect(first.status).toBe('saved');
    expect(
      (sections['bodyEntries'] as { measuredOn: string }[]).map((row) => row.measuredOn),
    ).toEqual(['2025-09-20', '2025-10-05']);
    expect(sections['bodyEntries'][1]).toEqual({
      id: first.status === 'saved' ? first.entry.id : '',
      measuredOn: '2025-10-05',
      weightKg: 82.4,
      bodyFatPct: 16.9,
      fatMethod: 'navy',
      waistCm: 86,
      neckCm: null,
      hipCm: null,
      armCm: null,
      thighCm: null,
      note: 'de manhã',
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(sections['bodyProfile']).toEqual({
      heightCm: 180,
      birthDate: '1995-06-15',
      sex: 'male',
      activityFactor: 1.55,
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    // Medição apagada não vai no arquivo (nem o que ela guardava).
    expect(JSON.stringify(document)).not.toContain('apagada');
  });

  it('is empty without measurements and has a null profile until it is filled in', async () => {
    setupBody();

    const document = await TestBed.inject(ExportService).buildJson();

    expect(document.sections).toMatchObject({ bodyEntries: [], bodyProfile: null });
  });

  it('uses names that do not clash with the other sections of the file', async () => {
    setupBody();

    const keys = Object.keys((await TestBed.inject(ExportService).buildJson()).sections);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['bodyEntries', 'bodyProfile']));
  });
});
