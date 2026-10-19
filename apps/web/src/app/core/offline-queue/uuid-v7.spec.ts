import { createUuidV7Generator, isUuid, uuidV7 } from './uuid-v7';

describe('uuidV7', () => {
  it('has the version 7 and variant bits and is a valid UUID', () => {
    const id = uuidV7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const ms = 1_760_000_000_123;
    const next = createUuidV7Generator({ now: () => ms, randomBytes: (n) => new Uint8Array(n) });
    const hex = next().replaceAll('-', '').slice(0, 12);
    expect(parseInt(hex, 16)).toBe(ms);
  });

  it('sorts in creation order, also inside the same millisecond and when the clock steps back', () => {
    let ms = 1_760_000_000_000;
    const next = createUuidV7Generator({
      now: () => ms,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    });
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(next()); // todos no mesmo milissegundo
    ms += 5;
    for (let i = 0; i < 50; i++) ids.push(next());
    ms -= 3_000; // relógio que recuou: a ordem continua
    for (let i = 0; i < 50; i++) ids.push(next());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the order even when the counter overflows inside one millisecond', () => {
    const next = createUuidV7Generator({
      now: () => 1_760_000_000_000,
      randomBytes: (n) => new Uint8Array(n),
    });
    const ids = Array.from({ length: 5_000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not accept text that is not a UUID', () => {
    expect(isUuid('nao-e-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
