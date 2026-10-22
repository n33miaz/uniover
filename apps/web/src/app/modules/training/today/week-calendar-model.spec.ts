import { moveMonth, sundayMonth, sundayWeek } from './week-calendar-model';

describe('training calendar', () => {
  it('shows Sunday through Saturday with numeric dates across a month boundary', () => {
    const week = sundayWeek(Date.UTC(2026, 9, 22, 12), 0, 'America/Sao_Paulo');
    expect(week.days.map((day) => day.key)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(sundayWeek(Date.UTC(2026, 9, 22, 12), -3, 'America/Sao_Paulo').days[0].key).toBe(
      '2026-09-27',
    );
  });

  it('keeps a local Sunday during a daylight saving change', () => {
    const week = sundayWeek(Date.UTC(2026, 2, 8, 12), 0, 'America/New_York');
    expect(week.days[0].key).toBe('2026-03-08');
    expect(week.days[6].key).toBe('2026-03-14');
    expect(week.end - week.start).toBe(167 * 60 * 60 * 1000);
  });

  it('pads the monthly calendar from Sunday and moves through years', () => {
    const cells = sundayMonth({ year: 2026, month: 10 });
    expect(cells).toHaveLength(35);
    expect(cells[0]?.day).toBeUndefined();
    expect(cells[4]?.day).toBe(1);
    expect(cells[34]?.day).toBe(31);
    expect(moveMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });
});
