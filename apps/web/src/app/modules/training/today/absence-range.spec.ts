import { absenceDays } from './absence-range';

describe('absenceDays', () => {
  it('lists every civil day of the range, both ends included', () => {
    expect(absenceDays('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(absenceDays('2026-10-27', '2026-10-27')).toEqual(['2026-10-27']);
  });

  it('refuses reversed, malformed and oversized ranges', () => {
    expect(absenceDays('2026-11-02', '2026-10-30')).toEqual([]);
    expect(absenceDays('', '2026-10-30')).toEqual([]);
    expect(absenceDays('2026-13-40', '2026-13-41')).toEqual([]);
    expect(absenceDays('2026-01-01', '2028-01-01')).toEqual([]);
  });
});
