import { TestBed } from '@angular/core/testing';
import { IdempotencyKeys, keepsKeyAfter, requiresIdempotencyKey } from './idempotency';

describe('requiresIdempotencyKey', () => {
  it.each([
    ['PATCH', '/api/v1/identity/me'],
    ['POST', '/api/v1/identity/guest-invites/abc/revoke'],
    ['POST', '/api/v1/identity/guests/abc/revoke'],
    ['PUT', '/api/v1/identity/guests/abc/permissions'],
    ['POST', '/api/v1/identity/guests/g/sessions/s/revoke'],
    ['POST', '/api/v1/identity/sessions/others/revoke'],
    ['POST', '/api/v1/identity/sessions/abc/revoke'],
    ['PATCH', '/api/v1/identity/passkeys/abc'],
    ['DELETE', '/api/v1/identity/passkeys/abc'],
    ['POST', '/api/v1/devices/pairing/approve'],
    ['POST', '/api/v1/devices/pairing/approve-own'],
    ['POST', '/api/v1/devices/pairing/deny'],
    ['POST', '/api/v1/devices/agents/abc/maintenance'],
    ['POST', '/api/v1/devices/agents/abc/revoke'],
    ['POST', '/api/v1/training/catalog/imports/wger'],
  ])('%s %s asks for a key', (method, url) => {
    expect(requiresIdempotencyKey(method, url)).toBe(true);
  });

  it.each([
    ['GET', '/api/v1/identity/me'],
    ['POST', '/api/v1/identity/auth/login'],
    ['POST', '/api/v1/identity/auth/refresh'],
    ['POST', '/api/v1/identity/auth/qr/approve'],
    ['POST', '/api/v1/identity/guest-invites/accept'],
    ['POST', '/api/v1/identity/guest-invites'],
    ['POST', '/api/v1/identity/passkeys/registration/options'],
    ['POST', '/api/v1/identity/step-up/options'],
    ['POST', '/api/v1/devices/pairing/start'],
    ['POST', '/api/v1/devices/agents/abc/logs'],
    ['POST', '/api/v1/tv/keys'],
    ['POST', '/api/v1/tv/power/off'],
    ['POST', '/api/v1/training/sessions'],
    ['PATCH', '/api/v1/identity/me/extra'],
    ['POST', '/other/api/v1/identity/guest-invites'],
  ])('%s %s does not', (method, url) => {
    expect(requiresIdempotencyKey(method, url)).toBe(false);
  });
});

describe('keepsKeyAfter', () => {
  it.each([
    [0, ''],
    [500, ''],
    [503, ''],
    [408, ''],
    [425, ''],
    [429, ''],
    [409, 'idempotency-in-progress'],
  ])('status %i %s keeps the key (the API may not have stored the result)', (status, kind) => {
    expect(keepsKeyAfter(status, kind)).toBe(true);
  });

  it.each([
    [200, ''],
    [204, ''],
    [400, 'validation'],
    [403, 'step-up-required'],
    [404, ''],
    [409, 'conflict'],
    [422, 'idempotency-key-reused'],
  ])('status %i %s ends the action: the next attempt uses a new key', (status, kind) => {
    expect(keepsKeyAfter(status, kind)).toBe(false);
  });
});

describe('IdempotencyKeys', () => {
  const keys = () => TestBed.inject(IdempotencyKeys);
  const URL = '/api/v1/identity/me';

  it('gives no key to routes that do not ask for one', () => {
    const ticket = keys().begin('POST', '/api/v1/identity/auth/login', '{}');
    expect(ticket.key).toBeNull();
    expect(() => ticket.settle(200)).not.toThrow();
  });

  it('shares one key between identical attempts in flight (double tap)', () => {
    const first = keys().begin('PATCH', URL, '{"a":1}');
    const second = keys().begin('PATCH', URL, '{"a":1}');
    expect(first.key).not.toBeNull();
    expect(second.key).toBe(first.key);
  });

  it('keeps the key after a network failure and drops it after success', () => {
    const first = keys().begin('PATCH', URL, '{"a":1}');
    first.settle(0, 'network');
    const retry = keys().begin('PATCH', URL, '{"a":1}');
    expect(retry.key).toBe(first.key);

    retry.settle(201);
    const next = keys().begin('PATCH', URL, '{"a":1}');
    expect(next.key).not.toBe(first.key);
  });

  it('a different body or address is another action', () => {
    const base = keys().begin('PATCH', URL, '{"a":1}');
    expect(keys().begin('PATCH', URL, '{"a":2}').key).not.toBe(base.key);
    expect(keys().begin('POST', '/api/v1/identity/guest-invites/x/revoke', '{"a":1}').key).not.toBe(
      base.key,
    );
  });

  it('a late settle of an older attempt does not drop a newer key', () => {
    const first = keys().begin('PATCH', URL, '{}');
    first.settle(403, 'step-up-required');
    const second = keys().begin('PATCH', URL, '{}');
    first.settle(403, 'step-up-required');
    expect(keys().begin('PATCH', URL, '{}').key).toBe(second.key);
  });

  it('forgets the oldest action beyond the limit instead of growing without bound', () => {
    const first = keys().begin('PATCH', URL, 'primeiro');
    for (let i = 0; i < 250; i++) keys().begin('PATCH', URL, `corpo-${i}`);
    expect(keys().begin('PATCH', URL, 'primeiro').key).not.toBe(first.key);
  });
});
