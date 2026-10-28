import type { LocalBodyEntry } from '../../data/body/body-entry';
import { bodyMapSignals, type BodyMapRegion } from './body-map-signals';

const entry = (values: Partial<LocalBodyEntry>): LocalBodyEntry => ({
  id: 'entry',
  measuredOn: '2026-10-20',
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

const region = (entries: LocalBodyEntry[], name: BodyMapRegion) =>
  bodyMapSignals(entries).find((item) => item.region === name)!;

describe('body map signals', () => {
  it('stays neutral with no measurements and with only one', () => {
    expect(
      bodyMapSignals([]).every((item) => item.change === 'neutral' && item.symmetry === null),
    ).toBe(true);
    expect(region([entry({ chestCm: 90 })], 'chest').change).toBe('neutral');
  });

  it('compares the two latest values of a region (oldest first, as the repository returns)', () => {
    const rows = [entry({ chestCm: 86 }), entry({ chestCm: 88 })];
    expect(region(rows, 'chest').change).toBe('up');
    expect(region([...rows].reverse(), 'chest').change).toBe('down');
    expect(region([entry({ chestCm: 88 }), entry({ chestCm: 88 })], 'chest').change).toBe('same');
  });

  it('skips measurements that lack the region and compares the nearest ones that have it', () => {
    const rows = [entry({ chestCm: 86 }), entry({ weightKg: 80 }), entry({ chestCm: 87.5 })];
    expect(region(rows, 'chest').change).toBe('up');
  });

  it('compares the same side only, never the right arm against an average of both', () => {
    const rows = [
      entry({ armRightCm: 30, armLeftCm: 36 }),
      entry({ armRightCm: 31, armLeftCm: null }),
    ];
    expect(region(rows, 'arm').change).toBe('up');
    const noCommonSide = [entry({ armLeftCm: 30 }), entry({ armRightCm: 40 })];
    expect(region(noCommonSide, 'arm').change).toBe('neutral');
  });

  it('keeps old measurements without a side comparable with each other', () => {
    const rows = [entry({ armCm: 33 }), entry({ armCm: 32 })];
    expect(region(rows, 'arm').change).toBe('down');
    expect(region(rows, 'arm').symmetry).toBeNull();
  });

  it('reports the symmetry only when the latest measurement with both sides exists', () => {
    const arm = region([entry({ armRightCm: 35, armLeftCm: 34 })], 'arm');
    expect(arm.symmetry).toEqual({ rightCm: 35, leftCm: 34, differenceCm: 1, larger: 'right' });
    expect(region([entry({ armRightCm: 35 })], 'arm').symmetry).toBeNull();
    expect(region([entry({ chestCm: 90 })], 'chest').symmetry).toBeNull();
  });

  it('rounds the difference without floating point noise and reports equal sides', () => {
    expect(
      region([entry({ thighLeftCm: 58.3, thighRightCm: 57.2 })], 'thigh').symmetry,
    ).toMatchObject({
      differenceCm: 1.1,
      larger: 'left',
    });
    expect(region([entry({ calfRightCm: 38, calfLeftCm: 38 })], 'calf').symmetry).toMatchObject({
      differenceCm: 0,
      larger: null,
    });
  });

  it('takes the symmetry from the newest measurement that has both sides', () => {
    const rows = [
      entry({ forearmRightCm: 27, forearmLeftCm: 26 }),
      entry({ forearmRightCm: 28, forearmLeftCm: null }),
    ];
    expect(region(rows, 'forearm').symmetry?.rightCm).toBe(27);
  });

  it('ignores deleted measurements', () => {
    const rows = [entry({ chestCm: 80 }), entry({ chestCm: 99, deletedAt: 5 })];
    expect(region(rows, 'chest').change).toBe('neutral');
  });
});
