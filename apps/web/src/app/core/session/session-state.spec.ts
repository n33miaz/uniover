import { effect } from '@angular/core';
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
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

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

    it('tells "empty" from "not known": no list is null, an empty list is a real answer', () => {
      expect(state().knownPermissions()).toBeNull();
      state().setUser({ ...user, permissions: [] });
      expect(state().knownPermissions()).toEqual([]);
      state().setUser(user);
      expect(state().knownPermissions()).toBeNull();
    });

    it('remembers the list as a hint for the next start without network, and forgets it on exit', () => {
      state().setUser({ ...user, role: 'guest', permissions: ['module:training'] });
      expect(JSON.parse(localStorage.getItem('uniover.account-permissions')!)).toEqual([
        'module:training',
      ]);
      TestBed.resetTestingModule();
      // Reinício sem rede: ainda não há usuário, e a dica diz o que a conta podia.
      expect(TestBed.inject(SessionState).knownPermissions()).toEqual(['module:training']);
      TestBed.inject(SessionState).clear();
      expect(localStorage.getItem('uniover.account-permissions')).toBeNull();
      expect(TestBed.inject(SessionState).knownPermissions()).toBeNull();
    });

    it('ignores a remembered list that is not a list of texts', () => {
      localStorage.setItem('uniover.account-permissions', JSON.stringify({ a: 1 }));
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).knownPermissions()).toBeNull();
      localStorage.setItem('uniover.account-permissions', JSON.stringify([1, 2]));
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).knownPermissions()).toBeNull();
    });

    it('the list from the server replaces the remembered one as soon as it arrives', () => {
      localStorage.setItem('uniover.account-permissions', JSON.stringify(['module:tv']));
      TestBed.resetTestingModule();
      state().setUser({ ...user, role: 'guest', permissions: ['module:training'] });
      expect(state().knownPermissions()).toEqual(['module:training']);
    });
  });

  describe('reading the same account again', () => {
    // Guardar uma conta de convidado grava a dica do papel no `localStorage`, que os arquivos de teste dividem.
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    const guest = {
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'guest',
      permissions: ['module:tv', 'tv:control', 'tv:power'],
    };

    it('reports whether the account changed, comparing by content and not by reference', () => {
      expect(state().setUser(guest)).toBe(true);
      expect(state().setUser({ ...guest, permissions: [...guest.permissions] })).toBe(false);
      expect(state().setUser({ ...guest, permissions: ['module:tv', 'tv:control'] })).toBe(true);
      expect(state().setUser({ ...guest, displayName: 'B' })).toBe(true);
    });

    it('keeps the very same permissions value when the set did not change', () => {
      state().setUser(guest);
      const before = state().permissions();
      // Lista nova, mesma coisa (até com outra ordem): o valor lido continua sendo o mesmo objeto.
      state().setUser({ ...guest, permissions: ['tv:power', 'module:tv', 'tv:control'] });
      expect(state().permissions()).toBe(before);
      // Só o nome mudou: quem lê permissões não é avisado.
      state().setUser({ ...guest, displayName: 'B', permissions: [...guest.permissions] });
      expect(state().permissions()).toBe(before);
    });

    it('notifies readers once when the permissions change, and not at all when they do not', () => {
      state().setUser(guest);
      const seen: string[] = [];
      TestBed.runInInjectionContext(() =>
        effect(() => {
          seen.push(state().permissions().join(','));
        }),
      );
      TestBed.tick();
      expect(seen).toEqual(['module:tv,tv:control,tv:power']);

      state().setUser({ ...guest, permissions: [...guest.permissions] });
      state().setUser({ ...guest, displayName: 'B' });
      TestBed.tick();
      expect(seen).toHaveLength(1);

      state().setUser({ ...guest, permissions: ['module:tv', 'tv:control'] });
      TestBed.tick();
      expect(seen).toEqual(['module:tv,tv:control,tv:power', 'module:tv,tv:control']);
    });

    it('does not rebuild the user for readers when nothing in it changed', () => {
      state().setUser(guest);
      const before = state().user();
      state().setUser({ ...guest, permissions: [...guest.permissions] });
      expect(state().user()).toBe(before);
    });
  });

  describe('account', () => {
    const user = { id: 'conta-a', email: 'a@b.c', displayName: 'A' };
    const tokenFor = (accountId: string) =>
      `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ sub: accountId }))}.assinatura`;
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('is unknown until a user or a remembered account exists', () => {
      expect(state().accountId()).toBeNull();
    });

    it('is the id of the user once /me answers, and remembered for the next start without network', () => {
      state().setUser(user);
      expect(state().accountId()).toBe('conta-a');
      expect(localStorage.getItem('uniover.account-id')).toBe('conta-a');

      // Reinício sem rede: ainda não há usuário, e a dica diz qual banco local abrir.
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).user()).toBeNull();
      expect(TestBed.inject(SessionState).accountId()).toBe('conta-a');
    });

    it('is forgotten on exit: no hint left, so no database of an account is opened without a known account', () => {
      state().setUser(user);
      state().clear();
      expect(state().accountId()).toBeNull();
      expect(localStorage.getItem('uniover.account-id')).toBeNull();
      TestBed.resetTestingModule();
      expect(TestBed.inject(SessionState).accountId()).toBeNull();
    });

    it('the id from /me replaces a remembered one that is different', () => {
      localStorage.setItem('uniover.account-id', 'conta-antiga');
      TestBed.resetTestingModule();
      expect(state().accountId()).toBe('conta-antiga');
      state().setUser(user);
      expect(state().accountId()).toBe('conta-a');
      expect(localStorage.getItem('uniover.account-id')).toBe('conta-a');
    });

    it('ignores a remembered value that is not a safe id, and an id from /me that is not one', () => {
      localStorage.setItem('uniover.account-id', '../x');
      TestBed.resetTestingModule();
      expect(state().accountId()).toBeNull();
      state().setUser({ ...user, id: 'a/b' });
      expect(state().accountId()).toBeNull();
      expect(localStorage.getItem('uniover.account-id')).toBeNull();
    });

    it('records the first confirmed account as the owner of the old databases, and keeps it', () => {
      state().setUser(user);
      state().clear();
      state().setUser({ ...user, id: 'conta-b' });
      expect(localStorage.getItem('uniover.legacy-owner')).toBe('conta-a');
    });

    it('never gives the queue a token from another account, even with an old /me result', () => {
      state().setUser(user);
      state().setToken(tokenFor('conta-b'), 600);
      expect(state().bearerOf('conta-a')).toBeNull();
      expect(state().bearerOf('conta-b')).toBeNull();

      state().setUser({ ...user, id: 'conta-b' });
      expect(state().bearerOf('conta-b')).toBe(tokenFor('conta-b'));
    });

    it('does not use an opaque token for account data even when /me matches', () => {
      state().setUser(user);
      state().setToken('token-sem-sub', 600);
      expect(state().bearerOf('conta-a')).toBeNull();
    });

    describe('is the session of an account', () => {
      it('only after /me confirmed it: a remembered account is not enough', () => {
        localStorage.setItem('uniover.account-id', 'conta-a');
        TestBed.resetTestingModule();
        expect(state().isSessionOf('conta-a')).toBe(false);
        state().setUser(user);
        expect(state().isSessionOf('conta-a')).toBe(true);
        expect(state().isSessionOf('conta-b')).toBe(false);
      });

      it('and stops being true when another tab enters another account (the refresh cookie is shared)', () => {
        state().setUser(user);
        localStorage.setItem('uniover.account-id', 'conta-b'); // a outra aba entrou como B
        expect(state().isSessionOf('conta-a')).toBe(false);
        localStorage.removeItem('uniover.account-id'); // ou saiu
        expect(state().isSessionOf('conta-a')).toBe(false);
        state().setUser(user); // esta aba confirma de novo
        expect(state().isSessionOf('conta-a')).toBe(true);
      });

      it('keeps working when the device lets nothing be stored (there is nothing to compare with)', () => {
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new Error('cheio');
        });
        try {
          state().setUser(user);
          expect(state().accountId()).toBe('conta-a');
          expect(state().isSessionOf('conta-a')).toBe(true);
        } finally {
          set.mockRestore();
        }
      });
    });
  });
});
