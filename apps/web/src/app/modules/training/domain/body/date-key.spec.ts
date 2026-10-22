import { addDaysToKey, daysBetween, parseDateKey } from './date-key';

describe('date keys', () => {
  it('reads real days and refuses the rest', () => {
    expect(parseDateKey('2026-10-21')).toEqual({ year: 2026, month: 10, day: 21 });
    expect(parseDateKey('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDateKey('2025-02-29')).toBeNull();
    expect(parseDateKey('2026-13-01')).toBeNull();
    expect(parseDateKey('2026-04-31')).toBeNull();
    expect(parseDateKey('2026-1-1')).toBeNull();
    expect(parseDateKey('hoje')).toBeNull();
    expect(parseDateKey('')).toBeNull();
  });

  it('counts whole days across months, years and leap days', () => {
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14);
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14);
    expect(daysBetween('2023-12-31', '2024-03-01')).toBe(61);
    expect(daysBetween('2026-10-21', '2026-10-21')).toBe(0);
    expect(daysBetween('2026-10-21', 'x')).toBeNull();
  });

  it('adds days on the calendar, in both directions', () => {
    expect(addDaysToKey('2026-10-21', 14)).toBe('2026-11-04');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToKey('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('nada', 1)).toBeNull();
  });

  it('does not depend on the timezone of the machine (the day is a calendar day)', () => {
    // Em qualquer fuso, somar 1 dia a 2026-03-08 (mudança de horário nos EUA) dá 2026-03-09.
    expect(addDaysToKey('2026-03-08', 1)).toBe('2026-03-09');
    expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1);
  });
});
