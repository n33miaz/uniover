import {
  formatBytes,
  formatDaysAhead,
  formatHours,
  formatPercent,
  formatUptime,
  sparklinePoints,
} from './capacity-format';

const MIB = 1024 * 1024;

describe('capacity format', () => {
  it('writes bytes in the unit that fits, base 1024, with pt-BR decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(336 * 1024)).toBe('336 KB');
    expect(formatBytes(14.7 * MIB)).toBe('14,7 MB');
    expect(formatBytes(512 * MIB)).toBe('512 MB');
    expect(formatBytes(1024 * MIB)).toBe('1 GB');
    expect(formatBytes(1.5 * 1024 * MIB)).toBe('1,5 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('keeps one decimal for small percentages and rounds the large ones', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1.44)).toBe('1,4%');
    expect(formatPercent(9.96)).toBe('10%');
    expect(formatPercent(54.6)).toBe('55%');
    expect(formatPercent(120)).toBe('120%');
  });

  it('shows the uptime with two units at most', () => {
    expect(formatUptime(0)).toBe('0 min');
    expect(formatUptime(8 * 60 + 5)).toBe('8 min');
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe('5 h 12 min');
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59)).toBe('3 d 4 h');
    expect(formatUptime(-10)).toBe('0 min');
  });

  it('rounds the month hours to whole hours', () => {
    expect(formatHours(611.6)).toBe('612 h');
    expect(formatHours(-3)).toBe('0 h');
  });

  it('says when a limit is reached, or that there is no honest date', () => {
    expect(formatDaysAhead(null)).toBe('Sem data');
    expect(formatDaysAhead(undefined)).toBe('Sem data');
    expect(formatDaysAhead(0)).toBe('Já passou');
    expect(formatDaysAhead(0.4)).toBe('Menos de 1 dia');
    expect(formatDaysAhead(1.2)).toBe('Em 1 dia');
    expect(formatDaysAhead(41.2)).toBe('Em 41 dias');
    expect(formatDaysAhead(180)).toBe('Em 6 meses');
    expect(formatDaysAhead(900)).toBe('Mais de 2 anos');
  });

  it('draws the sparkline top-down and centers a flat series', () => {
    expect(sparklinePoints([], 100, 40)).toBe('');
    expect(sparklinePoints([5], 100, 40)).toBe('0.0,20.0');
    expect(sparklinePoints([10, 10, 10], 100, 40)).toBe('0.0,20.0 50.0,20.0 100.0,20.0');
    // O maior valor fica no topo (y = 0) e o menor embaixo (y = altura).
    expect(sparklinePoints([0, 10, 5], 100, 40)).toBe('0.0,40.0 50.0,0.0 100.0,20.0');
  });
});
