import { OPERATION_HEADER, newOperationId } from './pc-operation';

describe('newOperationId', () => {
  it('has the format the contract accepts', () => {
    expect(newOperationId()).toMatch(/^[0-9a-f]{16}$/);
    expect(OPERATION_HEADER).toBe('X-Operation-Id');
  });

  it('is different every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newOperationId()));
    expect(ids.size).toBe(200);
  });

  it('still works where the secure random source is missing', () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(newOperationId()).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
