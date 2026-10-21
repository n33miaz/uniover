import { at } from '../domain/progress/progress-test-kit';
import { monthGrid, shiftMonth, weekAt } from './calendar-nav';

const SAO_PAULO = 'America/Sao_Paulo';
const NEW_YORK = 'America/New_York';

describe('weekAt', () => {
  it('is the week of today (Monday to Sunday) with no offset', () => {
    // 21/10/2026 é uma quarta-feira: a semana vai de 19 a 25.
    const week = weekAt(at('2026-10-21', 12), 0, SAO_PAULO);
    expect(week.startKey).toBe('2026-10-19');
    expect(week.endKey).toBe('2026-10-25');
  });

  it('walks back and forth in whole weeks', () => {
    const now = at('2026-10-21', 12);
    expect(weekAt(now, -1, SAO_PAULO).startKey).toBe('2026-10-12');
    expect(weekAt(now, -3, SAO_PAULO).startKey).toBe('2026-09-28');
    expect(weekAt(now, 1, SAO_PAULO).startKey).toBe('2026-10-26');
  });

  it('keeps Monday to Sunday across the change of month and of year', () => {
    const crossing = weekAt(at('2026-10-21', 12), -3, SAO_PAULO);
    expect([crossing.startKey, crossing.endKey]).toEqual(['2026-09-28', '2026-10-04']);

    const newYear = weekAt(at('2027-01-01', 12), 0, SAO_PAULO);
    expect([newYear.startKey, newYear.endKey]).toEqual(['2026-12-28', '2027-01-03']);
  });

  it('counts calendar days, not 168 hours, across a clock change', () => {
    // Em Nova York o horário de verão começou em 8/3/2026 (domingo): essa semana tem 167 horas.
    const now = Date.UTC(2026, 2, 12, 16);
    const week = weekAt(now, -1, NEW_YORK);
    expect(week.startKey).toBe('2026-03-02');
    expect((week.end - week.start) / 3_600_000).toBe(167);
    expect(weekAt(now, 0, NEW_YORK).startKey).toBe('2026-03-09');
  });
});

describe('shiftMonth', () => {
  it('moves by months, with the change of year', () => {
    expect(shiftMonth({ year: 2026, month: 10 }, -1)).toEqual({ year: 2026, month: 9 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 10 }, -13)).toEqual({ year: 2025, month: 9 });
  });
});

describe('monthGrid', () => {
  it('lays the month out in weeks from Monday, with blanks only at the edges', () => {
    // Outubro de 2026 começa numa quinta-feira e tem 31 dias.
    const grid = monthGrid(2026, 10, 31);
    expect(grid[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(grid[grid.length - 1]).toEqual([26, 27, 28, 29, 30, 31, null]);
    expect(grid).toHaveLength(5);
    expect(grid.flat().filter((day) => day !== null)).toHaveLength(31);
  });

  it('needs six rows when the month starts late and is long', () => {
    // Agosto de 2026 começa num sábado e tem 31 dias: seis semanas.
    const grid = monthGrid(2026, 8, 31);
    expect(grid[0]).toEqual([null, null, null, null, null, 1, 2]);
    expect(grid).toHaveLength(6);
  });

  it('has no blank row for a February that fits four weeks exactly', () => {
    // Fevereiro de 2027 começa numa segunda-feira e tem 28 dias.
    const grid = monthGrid(2027, 2, 28);
    expect(grid).toHaveLength(4);
    expect(grid[0][0]).toBe(1);
    expect(grid[3][6]).toBe(28);
  });
});
