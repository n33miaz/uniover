import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authGuard } from './auth.guard';
import { moduleGuard, ownerOnlyGuard } from './role.guard';

@Component({ template: '' })
class Screen {}

describe('ownerOnlyGuard', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };
  const me = (role?: string) => ({ id: '1', email: 'a@b.c', displayName: 'A', role });

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Screen },
          {
            path: '',
            canMatch: [authGuard],
            children: [
              { path: 'tv', component: Screen },
              { path: 'treino', component: Screen, canMatch: [ownerOnlyGuard] },
              { path: 'ajustes', component: Screen, canMatch: [ownerOnlyGuard] },
              { path: '', pathMatch: 'full', component: Screen },
            ],
          },
          { path: '**', redirectTo: '' },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  const go = async (url: string) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router).url;
  };

  it.each(['/', '/treino', '/ajustes'])('lets the owner into %s', async (url) => {
    api.me.mockResolvedValue(me('owner'));
    expect(await go(url)).toBe(url);
  });

  it('treats an answer without a role as the owner (an older server)', async () => {
    api.me.mockResolvedValue(me(undefined));
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it.each(['/treino', '/ajustes', '/nada-aqui'])(
    'sends the guest from %s to Início',
    async (url) => {
      api.me.mockResolvedValue(me('guest'));
      expect(await go(url)).toBe('/');
    },
  );

  it('lets the guest keep the TV', async () => {
    api.me.mockResolvedValue(me('guest'));
    expect(await go('/tv')).toBe('/tv');
  });

  it('never locks the owner out while the role is still unknown (offline, session to confirm)', async () => {
    api.refresh.mockRejectedValue(networkProblem());
    expect(TestBed.inject(SessionState).role()).toBeNull();
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it('uses the remembered role while the session cannot be confirmed (a guest offline goes to Início)', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    api.refresh.mockRejectedValue(networkProblem());
    expect(await go('/treino')).toBe('/');
  });

  it('does not use a remembered role once the server says the session is gone', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    expect(await go('/treino')).toBe('/entrar?next=%2Ftreino');
    expect(localStorage.getItem('uniover.account-role')).toBeNull();
  });
});

describe('the guest goes to Início, where the account sees its permitted modules', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };
  const guest = (permissions?: string[]) => ({
    id: '1',
    email: 'a@b.c',
    displayName: 'A',
    role: 'guest',
    permissions,
  });
  const TV = ['module:tv', 'tv:control'];
  const TRAINING = ['module:training'];

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Screen },
          {
            path: '',
            canMatch: [authGuard],
            children: [
              { path: 'tv', component: Screen },
              { path: 'treino', component: Screen, canMatch: [moduleGuard('training')] },
              { path: 'ajustes', component: Screen, canMatch: [ownerOnlyGuard] },
              { path: '', pathMatch: 'full', component: Screen },
            ],
          },
          { path: '**', redirectTo: '' },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  // O roteador de teste só aceita um "harness" por teste: vários caminhos no mesmo teste reaproveitam o primeiro.
  let harness: RouterTestingHarness | undefined;
  beforeEach(() => (harness = undefined));
  const go = async (url: string) => {
    harness ??= await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router).url;
  };

  it.each(['/', '/ajustes', '/nada-aqui'])(
    'sends a guest who only has the Treino from %s to Início',
    async (url) => {
      api.me.mockResolvedValue(guest(TRAINING));
      expect(await go(url)).toBe('/');
    },
  );

  it('lets the guest who has the Treino stay in it', async () => {
    api.me.mockResolvedValue(guest(TRAINING));
    expect(await go('/treino')).toBe('/treino');
  });

  it.each(['/', '/treino', '/ajustes'])(
    'sends a guest who only has the TV from %s to Início',
    async (url) => {
      api.me.mockResolvedValue(guest(TV));
      expect(await go(url)).toBe('/');
    },
  );

  it('keeps Início when the guest has both modules', async () => {
    api.me.mockResolvedValue(guest([...TV, ...TRAINING]));
    expect(await go('/')).toBe('/');
    expect(await go('/treino')).toBe('/treino');
  });

  it.each(['/', '/treino', '/ajustes'])(
    'sends a guest without any module from %s to Início',
    async (url) => {
      api.me.mockResolvedValue(guest([]));
      expect(await go(url)).toBe('/');
    },
  );

  it.each([
    ['without any module', []],
    ['with the TV', TV],
    ['with the Treino', TRAINING],
    ['with both', [...TV, ...TRAINING]],
  ])(
    'never redirects a guest %s to a place that would send the same account away again (no loops)',
    async (_name, permissions) => {
      api.me.mockResolvedValue(guest(permissions));
      const first = await go('/');
      expect(await go(first)).toBe(first);
    },
  );

  it('keeps Início for a guest whose list is unknown (an answer without the list)', async () => {
    api.me.mockResolvedValue(guest(undefined));
    expect(await go('/')).toBe('/');
    expect(await go('/treino')).toBe('/treino');
  });

  it('uses the remembered list while offline: the guest of the Treino sees Início', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    localStorage.setItem('uniover.account-permissions', JSON.stringify(TRAINING));
    api.refresh.mockRejectedValue(networkProblem());
    expect(await go('/')).toBe('/');
    expect(await go('/treino')).toBe('/treino');
  });

  it('never sends a guest to "no access" just because the network failed (list unknown)', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    api.refresh.mockRejectedValue(networkProblem());
    expect(await go('/treino')).toBe('/treino');
    expect(await go('/')).toBe('/');
  });

  it('lets the owner into every module', async () => {
    api.me.mockResolvedValue({ ...guest(), role: 'owner' });
    expect(await go('/treino')).toBe('/treino');
  });
});
