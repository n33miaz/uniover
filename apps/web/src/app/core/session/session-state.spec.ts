import { TestBed } from '@angular/core/testing';
import { SessionState } from './session-state';

describe('SessionState', () => {
  const state = () => TestBed.inject(SessionState);

  it('starts unknown with no token', () => {
    expect(state().status()).toBe('unknown');
    expect(state().bearer()).toBeNull();
    expect(state().hasToken()).toBe(false);
  });

  it('keeps the token in a private field, out of every signal and of JSON', () => {
    state().setToken('eyJ.segredo.token', 600);
    expect(state().status()).toBe('authenticated');
    expect(state().bearer()).toBe('eyJ.segredo.token');
    expect(JSON.stringify(state())).not.toContain('eyJ');
    const observable = Object.values(state()).map((value) =>
      typeof value === 'function' ? value() : value,
    );
    expect(JSON.stringify(observable)).not.toContain('eyJ');
  });

  it('does not hand out an expired token, but still knows it has one', () => {
    state().setToken('t', 10, 1_000);
    expect(state().bearer(5_000)).toBe('t');
    expect(state().bearer(11_000)).toBeNull();
    expect(state().hasToken()).toBe(true);
  });

  it('pending does not demote a session whose token is still valid', () => {
    state().setToken('t', 600);
    state().setPending();
    expect(state().status()).toBe('authenticated');
  });

  it('pending applies when there is no usable token', () => {
    state().setPending();
    expect(state().status()).toBe('pending');
  });

  it('clear forgets token and user', () => {
    state().setToken('t', 600);
    state().setUser({ id: '1', email: 'a@b.c', displayName: 'A' });
    state().clear();
    expect(state().status()).toBe('anonymous');
    expect(state().user()).toBeNull();
    expect(state().bearer()).toBeNull();
    expect(state().expiresAt()).toBeNull();
  });

  describe('role', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('is unknown until a user or a remembered role exists, and unknown is never "guest"', () => {
      expect(state().role()).toBeNull();
      expect(state().isGuest()).toBe(false);
    });

    it('reads the role of the loaded user; a user without a role is the owner', () => {
      state().setUser({ id: '1', email: 'a@b.c', displayName: 'A', role: 'guest' });
      expect(state().role()).toBe('guest');
      expect(state().isGuest()).toBe(true);
      state().setUser({ id: '1', email: 'a@b.c', displayName: 'A' });
      expect(state().role()).toBe('owner');
      expect(state().isGuest()).toBe(false);
    });

    it('remembers the role as a hint (not a secret) and forgets it when the session is cleared', () => {
      state().setUser({ id: '1', email: 'a@b.c', displayName: 'A', role: 'guest' });
      expect(localStorage.getItem('uniover.account-role')).toBe('guest');
      state().clear();
      expect(localStorage.getItem('uniover.account-role')).toBeNull();
      expect(state().role()).toBeNull();
    });

    it('starts from the remembered role when there is no user yet', () => {
      localStorage.setItem('uniover.account-role', 'guest');
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).isGuest()).toBe(true);
    });

    it('ignores a remembered value that is not a known role', () => {
      localStorage.setItem('uniover.account-role', 'admin');
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).role()).toBeNull();
    });

    it('works with storage blocked', () => {
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('bloqueado');
      });
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('bloqueado');
      });
      TestBed.resetTestingModule();
      expect(() =>
        TestBed.inject(SessionState).setUser({
          id: '1',
          email: 'a@b.c',
          displayName: 'A',
          role: 'guest',
        }),
      ).not.toThrow();
      expect(TestBed.inject(SessionState).isGuest()).toBe(true);
      get.mockRestore();
      set.mockRestore();
    });
  });

  describe('name and permissions', () => {
    const user = { id: '1', email: 'a@b.c', displayName: 'A' };

    it('only an explicit "name not chosen" asks the question', () => {
      expect(state().needsWelcome()).toBe(false);
      state().setUser({ ...user, displayNameConfirmed: false });
      expect(state().needsWelcome()).toBe(true);
      state().setUser({ ...user, displayNameConfirmed: true });
      expect(state().needsWelcome()).toBe(false);
    });

    it('an answer without the field (an older server) never asks, and no user never asks', () => {
      expect(state().needsWelcome()).toBe(false);
      state().setUser(user);
      expect(state().needsWelcome()).toBe(false);
    });

    it('forgetting the session forgets the question too', () => {
      state().setUser({ ...user, displayNameConfirmed: false });
      state().clear();
      expect(state().needsWelcome()).toBe(false);
    });

    it('keeps the permissions of the account, empty while unknown', () => {
      expect(state().permissions()).toEqual([]);
      state().setUser({ ...user, permissions: ['module:tv', 'tv:power'] });
      expect(state().permissions()).toEqual(['module:tv', 'tv:power']);
      state().setUser(user);
      expect(state().permissions()).toEqual([]);
    });
  });
});
