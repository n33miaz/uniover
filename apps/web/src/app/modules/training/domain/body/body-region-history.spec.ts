import type { LocalBodyEntry } from '../../data/body/body-entry';
import { regionHistory } from './body-region-history';

const entry = (
  id: string,
  measuredOn: string,
  values: Partial<LocalBodyEntry>,
): LocalBodyEntry => ({
  id,
  measuredOn,
  weightKg: null,
  bodyFatPct: null,
  fatMethod: null,
  waistCm: null,
  neckCm: null,
  hipCm: null,
  armCm: null,
  thighCm: null,
  note: '',
  updatedAt: 1,
  clientUpdatedAt: 1,
  deletedAt: null,
  ...values,
});

describe('body region history', () => {
  it('lists the newest first with the change against the previous value of the same field', () => {
    const rows = regionHistory(
      [
        entry('a', '2026-09-01', { armRightCm: 33, armLeftCm: 32 }),
        entry('b', '2026-10-01', { armRightCm: 34.1, armLeftCm: 31.5 }),
      ],
      'arm',
    );
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
    expect(rows[0].cells).toEqual([
      { field: 'armRightCm', side: 'right', valueCm: 34.1, deltaCm: 1.1 },
      { field: 'armLeftCm', side: 'left', valueCm: 31.5, deltaCm: -0.5 },
    ]);
    expect(rows[1].cells.every((cell) => cell.deltaCm === null)).toBe(true);
  });

  it('skips measurements without the region and never compares different sides', () => {
    const rows = regionHistory(
      [
        entry('a', '2026-09-01', { calfLeftCm: 38 }),
        entry('b', '2026-09-15', { weightKg: 80 }),
        entry('c', '2026-10-01', { calfRightCm: 39 }),
      ],
      'calf',
    );
    expect(rows.map((row) => row.id)).toEqual(['c', 'a']);
    expect(rows[0].cells[0]).toMatchObject({ side: 'right', deltaCm: null });
  });

  it('keeps the old unsided measure and ignores deleted rows', () => {
    const rows = regionHistory(
      [
        entry('a', '2026-09-01', { thighCm: 58 }),
        entry('b', '2026-10-01', { thighCm: 99, deletedAt: 7 }),
      ],
      'thigh',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cells[0]).toMatchObject({ side: null, valueCm: 58 });
  });

  it('is empty without data', () => {
    expect(regionHistory([], 'chest')).toEqual([]);
  });
});
