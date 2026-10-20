import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authGuard } from './auth.guard';
import { ownerOnlyGuard } from './role.guard';

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
              { path: '', pathMatch: 'full', component: Screen, canMatch: [ownerOnlyGuard] },
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

  it.each(['/', '/treino', '/ajustes', '/nada-aqui'])(
    'sends the guest from %s straight to the TV',
    async (url) => {
      api.me.mockResolvedValue(me('guest'));
      expect(await go(url)).toBe('/tv');
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

  it('uses the remembered role while the session cannot be confirmed (a guest offline stays on the TV)', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    api.refresh.mockRejectedValue(networkProblem());
    expect(await go('/treino')).toBe('/tv');
  });

  it('does not use a remembered role once the server says the session is gone', async () => {
    localStorage.setItem('uniover.account-role', 'guest');
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    expect(await go('/treino')).toBe('/entrar?next=%2Ftreino');
    expect(localStorage.getItem('uniover.account-role')).toBeNull();
  });
});
