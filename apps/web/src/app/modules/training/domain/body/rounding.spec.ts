import { round1, roundKcal, roundTo } from './rounding';

describe('rounding', () => {
  it('rounds half away from zero on the short decimal representation', () => {
    expect(round1(16.85)).toBe(16.9);
    expect(round1(16.84)).toBe(16.8);
    expect(round1(0.05)).toBe(0.1);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(round1(-0.05)).toBe(-0.1);
  });

  it('cleans the floating point noise of a long calculation before rounding', () => {
    // 16.85 escrito por uma conta longa: o ponto flutuante dá 16.849999999999998 e a aritmética ingênua arredondaria para 16.8.
    expect(16.849999999999998).not.toBe(16.85);
    expect(round1(16.849999999999998)).toBe(16.9);
    expect(round1(0.1 + 0.2)).toBe(0.3);
    expect(roundKcal(2788.4500000000003)).toBe(2788);
    expect(roundKcal(1799.5)).toBe(1800);
  });

  it('shows whole kilocalories and never returns negative zero', () => {
    expect(roundKcal(2788.45)).toBe(2788);
    expect(Object.is(round1(-0.04), 0)).toBe(true);
    expect(Object.is(roundKcal(-0.4), 0)).toBe(true);
    expect(roundTo(0, 1)).toBe(0);
  });

  it('passes non-finite numbers through', () => {
    expect(roundTo(Number.NaN, 1)).toBeNaN();
    expect(roundTo(Number.POSITIVE_INFINITY, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});
