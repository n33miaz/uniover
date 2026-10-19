import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  IN_PROGRESS_RETRY_MS,
  RETRY_AFTER_MAX_MS,
  SendOutcome,
  backoffDelayMs,
  classifyResult,
  parseRetryAfterMs,
} from './classify-result';

const context = { failures: 1, nowMs: 1_000_000, random: 0.5 };
const response = (
  status: number,
  headers: Record<string, string> = {},
  problemType?: string,
): SendOutcome => ({
  kind: 'response',
  status,
  headers,
  ...(problemType ? { problemType } : {}),
});

describe('backoffDelayMs', () => {
  it('doubles from 2 s up to the 5 min ceiling', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => backoffDelayMs(n, 0.5));
    expect(delays.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(delays[8]).toBe(BACKOFF_MAX_MS);
    expect(delays[9]).toBe(BACKOFF_MAX_MS);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });

  it('applies a jitter of plus or minus 20% and never passes the ceiling', () => {
    expect(backoffDelayMs(1, 0)).toBe(BACKOFF_BASE_MS * 0.8);
    expect(backoffDelayMs(1, 0.999)).toBeLessThanOrEqual(BACKOFF_BASE_MS * 1.2);
    expect(backoffDelayMs(20, 0.999)).toBe(BACKOFF_MAX_MS);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads seconds and HTTP dates and ignores nonsense', () => {
    expect(parseRetryAfterMs('7', 0)).toBe(7_000);
    expect(parseRetryAfterMs(' 3 ', 0)).toBe(3_000);
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(parseRetryAfterMs('Sun, 18 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('Sun, 18 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('logo', now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });

  it('caps absurd values', () => {
    expect(parseRetryAfterMs('99999999', 0)).toBe(RETRY_AFTER_MAX_MS);
  });
});

describe('classifyResult', () => {
  it('treats 2xx as done, also when the server replayed the stored answer', () => {
    expect(classifyResult(response(201), context)).toEqual({ action: 'done', replayed: false });
    expect(classifyResult(response(200, { 'idempotent-replayed': 'true' }), context)).toEqual({
      action: 'done',
      replayed: true,
    });
    expect(classifyResult(response(204), context).action).toBe('done');
  });

  it('retries with backoff when the network did not deliver', () => {
    expect(classifyResult({ kind: 'network-error' }, context)).toEqual({
      action: 'retry',
      delayMs: 2_000,
      reason: 'network',
    });
    expect(classifyResult({ kind: 'network-error' }, { ...context, failures: 3 })).toMatchObject({
      delayMs: 8_000,
    });
  });

  it.each([500, 502, 503, 504, 408])('retries on %i without failing the item', (status) => {
    const decision = classifyResult(response(status), context);
    expect(decision.action).toBe('retry');
  });

  it('recognizes Render waking up (502/503 with the routing header)', () => {
    expect(
      classifyResult(response(503, { 'x-render-routing': 'hibernate-wake' }), context),
    ).toMatchObject({
      action: 'retry',
      reason: 'server-waking',
    });
    expect(
      classifyResult(response(502, { 'x-render-routing': 'no-server' }), context),
    ).toMatchObject({
      reason: 'server-waking',
    });
  });

  it('obeys Retry-After on 429 and falls back to backoff without it', () => {
    expect(classifyResult(response(429, { 'retry-after': '7' }), context)).toEqual({
      action: 'retry',
      delayMs: 7_000,
      reason: 'rate-limited',
    });
    expect(classifyResult(response(429), context)).toMatchObject({ delayMs: 2_000 });
    expect(classifyResult(response(429, { 'retry-after': '0' }), context)).toMatchObject({
      delayMs: 1_000,
    });
  });

  it('retries in a few seconds when the same key is still in progress on the server', () => {
    expect(classifyResult(response(409, {}, 'idempotency-in-progress'), context)).toEqual({
      action: 'retry',
      delayMs: IN_PROGRESS_RETRY_MS,
      reason: 'idempotency-in-progress',
    });
  });

  it('keeps the item on 401 (waits for a session) and never marks it as failed', () => {
    expect(classifyResult(response(401), context)).toEqual({ action: 'auth' });
  });

  it.each([400, 404, 409, 413, 422])(
    'marks business refusal %i as a permanent failure',
    (status) => {
      expect(classifyResult(response(status), context)).toMatchObject({ action: 'failed' });
    },
  );

  it('describes the permanent failure with status and problem type, without user data', () => {
    expect(classifyResult(response(422, {}, 'idempotency-key-reused'), context)).toEqual({
      action: 'failed',
      reason: 'http-422:idempotency-key-reused',
    });
  });
});
