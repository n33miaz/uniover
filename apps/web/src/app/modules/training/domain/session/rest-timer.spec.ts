import {
  ADD_REST_MS,
  DEFAULT_REST_SECONDS,
  extendRest,
  isOver,
  remainingMs,
  restEndsAt,
  restSecondsFor,
} from './rest-timer';

describe('rest timer (pure)', () => {
  it('uses the rest of the routine item, or 90 s without a routine', () => {
    expect(restSecondsFor({ restSeconds: 120 })).toBe(120);
    expect(restSecondsFor({ restSeconds: 0 })).toBe(0);
    expect(restSecondsFor(null)).toBe(DEFAULT_REST_SECONDS);
    expect(restSecondsFor(undefined)).toBe(90);
  });

  it('works with the end instant, never with a counter', () => {
    const endsAt = restEndsAt(1_000, 90);

    expect(endsAt).toBe(91_000);
    expect(remainingMs(endsAt, 1_000)).toBe(90_000);
    expect(remainingMs(endsAt, 31_000)).toBe(60_000);
    // Depois de 10 minutos "bloqueado" o relógio basta para saber que acabou.
    expect(remainingMs(endsAt, 1_000 + 600_000)).toBe(0);
    expect(isOver(endsAt, 1_000 + 600_000)).toBe(true);
  });

  it('is over exactly at the end instant, and not before', () => {
    expect(isOver(5_000, 4_999)).toBe(false);
    expect(isOver(5_000, 5_000)).toBe(true);
  });

  it('has no remaining time and is not over without a timer', () => {
    expect(remainingMs(null, 123)).toBe(0);
    expect(isOver(null, 123)).toBe(false);
  });

  it('never goes negative with a negative duration', () => {
    expect(restEndsAt(1_000, -5)).toBe(1_000);
  });

  it('adds 15 s to a running rest, and counts from now when it had already ended', () => {
    expect(extendRest(10_000, 4_000)).toBe(10_000 + ADD_REST_MS);
    expect(extendRest(10_000, 50_000)).toBe(50_000 + ADD_REST_MS);
    expect(extendRest(10_000, 4_000, 5_000)).toBe(15_000);
  });
});
