import { formatKg } from '../shell/format';
import {
  dayMonthOfKey,
  formatAxisKg,
  formatMonthYear,
  formatOneRepMax,
  monthLabel,
  monthOnly,
  periodName,
  signedKg,
  weekLabel,
} from './progress-text';

describe('number formats (pt-BR)', () => {
  it('writes thousands with a dot and decimals with a comma', () => {
    expect(formatKg(4603)).toBe('4.603 kg');
    expect(formatKg(53.8)).toBe('53,8 kg');
    expect(formatKg(40)).toBe('40 kg');
  });

  it('gives the 1RM, an estimate, one decimal place', () => {
    // Epley: 42,5 × (1 + 8/30) = 53,8333...
    expect(formatOneRepMax(53.8333)).toBe('53,8 kg');
    expect(formatOneRepMax(50)).toBe('50 kg');
    expect(formatOneRepMax(1234.56)).toBe('1.234,6 kg');
  });

  it('writes the load axis without a unit', () => {
    expect(formatAxisKg(42.5)).toBe('42,5');
    expect(formatAxisKg(55)).toBe('55');
  });

  it('writes the change with a sign, a real minus and no sign when it did not move', () => {
    expect(signedKg(10.5)).toBe('+10,5 kg');
    expect(signedKg(-3)).toBe('−3 kg');
    expect(signedKg(0.02)).toBe('0 kg');
    expect(signedKg(-0.04)).toBe('0 kg');
  });
});

describe('dates', () => {
  it('turns a date key into day and month', () => {
    expect(dayMonthOfKey('2026-10-12')).toBe('12/10');
  });

  it('writes the month with the first letter in capitals', () => {
    expect(monthLabel(2026, 10)).toBe('Outubro de 2026');
    expect(monthOnly(2026, 3)).toBe('Março');
  });

  it('marks the long time axis with month and year', () => {
    // 10/10/2026 ao meio-dia, em segundos.
    expect(formatMonthYear(Date.UTC(2026, 9, 10, 15) / 1000)).toMatch(/out.* 26/);
  });

  it('names the period for the spoken label of the chart', () => {
    expect(periodName('8w')).toBe('nas últimas 8 semanas');
    expect(periodName('6m')).toBe('nos últimos 6 meses');
    expect(periodName('all')).toBe('em todo o histórico');
  });
});

describe('weekLabel', () => {
  it('writes a week inside one month as "12 a 18 de outubro"', () => {
    expect(weekLabel('2026-10-12', '2026-10-18')).toBe('12 a 18 de outubro');
  });

  it('names both months when the week crosses the month', () => {
    expect(weekLabel('2026-09-28', '2026-10-04')).toBe('28 de setembro a 4 de outubro');
  });

  it('adds the years when the week crosses the new year', () => {
    expect(weekLabel('2026-12-28', '2027-01-03')).toBe(
      '28 de dezembro de 2026 a 3 de janeiro de 2027',
    );
  });
});
