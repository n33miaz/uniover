import {
  LEGACY_OWNER_KEY,
  isLegacyAdoptionDone,
  markLegacyAdoptionDone,
  accountDatabaseName,
  claimLegacyOwner,
  isValidAccountId,
  readLegacyOwner,
} from './account-id';

describe('account id', () => {
  afterEach(() => localStorage.clear());

  it('accepts a UUID and the short ids of the test servers, and refuses anything unsafe for a database name', () => {
    expect(isValidAccountId('0199aaaa-0000-7000-8000-000000000001')).toBe(true);
    expect(isValidAccountId('u1')).toBe(true);
    for (const bad of [
      '',
      'a b',
      'a/b',
      'a.b',
      '../x',
      'ação',
      'x'.repeat(65),
      null,
      7,
      undefined,
    ]) {
      expect(isValidAccountId(bad), String(bad)).toBe(false);
    }
  });

  it('names the database of an account after it, never reusing the old single name', () => {
    expect(accountDatabaseName('uniover-training', 'u1')).toBe('uniover-training-u1');
    expect(accountDatabaseName('uniover-training', 'u1')).not.toBe('uniover-training');
    expect(accountDatabaseName('uniover-training', 'u1')).not.toBe(
      accountDatabaseName('uniover-training', 'u2'),
    );
    expect(() => accountDatabaseName('uniover-training', '../x')).toThrow(TypeError);
  });

  describe('owner of the old databases', () => {
    it('is the first account that claims it, and never changes', () => {
      expect(readLegacyOwner()).toBeNull();
      claimLegacyOwner('a');
      claimLegacyOwner('b');
      expect(readLegacyOwner()).toBe('a');
    });

    it('ignores a stored value that is not a valid id, and never stores an invalid one', () => {
      localStorage.setItem(LEGACY_OWNER_KEY, '../x');
      expect(readLegacyOwner()).toBeNull();
      localStorage.clear();
      claimLegacyOwner('../x');
      expect(localStorage.getItem(LEGACY_OWNER_KEY)).toBeNull();
    });

    it('survives storage that refuses everything: nobody owns, nothing breaks', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('bloqueado');
      });
      try {
        expect(readLegacyOwner()).toBeNull();
        expect(() => claimLegacyOwner('a')).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('memory that the adoption of an old database finished', () => {
    it('is per old database and per account', () => {
      expect(isLegacyAdoptionDone('uniover-training', 'a')).toBe(false);
      markLegacyAdoptionDone('uniover-training', 'a');

      expect(isLegacyAdoptionDone('uniover-training', 'a')).toBe(true);
      expect(isLegacyAdoptionDone('uniover-training', 'b')).toBe(false);
      expect(isLegacyAdoptionDone('uniover-offline', 'a')).toBe(false);
    });

    it('never stores an invalid id, and survives storage that refuses everything', () => {
      markLegacyAdoptionDone('uniover-training', '../x');
      expect(localStorage.length).toBe(0);

      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('cheio');
      });
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('bloqueado');
      });
      try {
        expect(() => markLegacyAdoptionDone('uniover-training', 'a')).not.toThrow();
        expect(isLegacyAdoptionDone('uniover-training', 'a')).toBe(false);
      } finally {
        set.mockRestore();
        get.mockRestore();
      }
    });
  });
});
