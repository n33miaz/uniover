import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SessionState } from '../session/session-state';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authGuard } from './auth.guard';
import { ownerOnlyGuard } from './role.guard';
import { welcomeGuard } from './welcome.guard';

@Component({ template: '' })
class Screen {}

describe('welcomeGuard', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };
  const me = (extra: Record<string, unknown> = {}) => ({
    id: '1',
    email: 'a@b.c',
    displayName: 'A',
    role: 'owner',
    permissions: [],
    ...extra,
  });

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(me({ displayNameConfirmed: false }));
    TestBed.configureTestingModule({
      providers: [
        // A mesma árvore do app: a pergunta fica fora da casca (e do guarda), tudo o mais passa por ele.
        provideRouter([
          { path: 'entrar', component: Screen },
          { path: 'boas-vindas', component: Screen, canMatch: [authGuard] },
          {
            path: '',
            canMatch: [authGuard, welcomeGuard],
            children: [
              { path: 'tv', component: Screen },
              { path: 'ajustes', component: Screen },
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

  it('sends a signed-in user who has not chosen a name to the question, remembering where they wanted to go', async () => {
    expect(await go('/ajustes')).toBe('/boas-vindas?next=%2Fajustes');
  });

  it('does not put the home page in next', async () => {
    expect(await go('/')).toBe('/boas-vindas');
  });

  it('keeps the query of the wanted address', async () => {
    expect(await go('/tv?painel=apps')).toBe('/boas-vindas?next=%2Ftv%3Fpainel%3Dapps');
  });

  it('asks the guest too, before the TV (which is the only screen a guest reaches)', async () => {
    api.me.mockResolvedValue(me({ role: 'guest', displayNameConfirmed: false }));
    expect(await go('/tv')).toBe('/boas-vindas?next=%2Ftv');
  });

  it('asks the guest before the redirect that would have taken them to the TV', async () => {
    api.me.mockResolvedValue(me({ role: 'guest', displayNameConfirmed: false }));
    expect(await go('/')).toBe('/boas-vindas');
  });

  it('lets through who already chose the name, and never shows them the question', async () => {
    api.me.mockResolvedValue(me({ displayNameConfirmed: true }));
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it('lets through an answer without the field (an older server)', async () => {
    api.me.mockResolvedValue(me());
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it('does not trap anyone when the session cannot be confirmed (no network, no user)', async () => {
    api.refresh.mockRejectedValue(networkProblem());
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it('does not trap anyone when the user cannot be read at all', async () => {
    api.me.mockRejectedValue(networkProblem());
    expect(await go('/ajustes')).toBe('/ajustes');
  });

  it('reads the user again once when the first read failed, and then asks the question', async () => {
    api.me
      .mockRejectedValueOnce(networkProblem())
      .mockResolvedValue(me({ displayNameConfirmed: false }));
    expect(await go('/ajustes')).toBe('/boas-vindas?next=%2Fajustes');
    expect(api.me).toHaveBeenCalledTimes(2);
  });

  it('keeps the sign-in first: nobody without a session is asked for a name', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    expect(await go('/ajustes')).toBe('/entrar?next=%2Fajustes');
  });

  it('the question itself is not behind this guard, and asking again does not chain redirects', async () => {
    const router = TestBed.inject(Router);
    const starts: string[] = [];
    router.events.subscribe((event) => {
      if (event instanceof NavigationStart) starts.push(event.url);
    });
    expect(await go('/boas-vindas')).toBe('/boas-vindas');

    // Com o servidor ainda dizendo "sem nome", cada tentativa de ir ao destino para na pergunta: o pedido e, no máximo, um
    // redirecionamento, nunca uma cadeia.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = starts.length;
      await router.navigateByUrl('/ajustes');
      expect(router.url).toBe('/boas-vindas?next=%2Fajustes');
      expect(starts.slice(before).length).toBeLessThanOrEqual(2);
    }
  });

  it('after the name is chosen the same address opens', async () => {
    expect(await go('/ajustes')).toBe('/boas-vindas?next=%2Fajustes');
    // A tela de boas-vindas troca o usuário da sessão ao salvar; aqui o mesmo, direto no estado.
    TestBed.inject(SessionState).setUser(me({ displayNameConfirmed: true }));
    await TestBed.inject(Router).navigateByUrl('/ajustes');
    expect(TestBed.inject(Router).url).toBe('/ajustes');
  });
});
