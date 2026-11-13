import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { JOIN_PATH, JOIN_SECRET_KEY, ShoppingJoinPage } from './shopping-join.page';
import { ShoppingPeopleApi } from './shopping-people-api';

@Component({ template: '' })
class Blank {}

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const OTHER = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-zyxwv';

describe('ShoppingJoinPage', () => {
  let tokens: string[];
  let outcome: unknown;
  let status: 'anonymous' | 'authenticated' | 'pending';
  let welcome: boolean;
  let replaced: string[];

  async function open(url: string): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'compras/convite', component: ShoppingJoinPage },
          { path: 'compras', component: Blank },
          { path: 'entrar', component: Blank },
          { path: 'boas-vindas', component: Blank },
          { path: '', component: Blank },
        ]),
        {
          provide: ShoppingPeopleApi,
          useValue: {
            acceptInvite: async (token: string) => {
              tokens.push(token);
              if (outcome) throw outcome;
              return { id: 'g1', isOwner: false };
            },
          },
        },
        {
          provide: AuthService,
          useFactory: () => {
            const router = TestBed.inject(Router);
            const tree = (path: string) => (next: string) =>
              router.createUrlTree([path], { queryParams: { next } });
            return {
              init: async () => undefined,
              ensureUser: async () => undefined,
              status: () => status,
              loginUrlTree: tree('/entrar') as (next: string) => UrlTree,
              welcomeUrlTree: tree('/boas-vindas') as (next: string) => UrlTree,
            };
          },
        },
        { provide: SessionState, useValue: { needsWelcome: () => welcome } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    // A tela navega mais de uma vez (limpa o endereço, depois entra ou segue): espera tudo assentar.
    for (let round = 0; round < 3; round++) {
      await new Promise((resolve) => setTimeout(resolve));
      await harness.fixture.whenStable();
    }
    harness.detectChanges();
    return harness.fixture.nativeElement as HTMLElement;
  }

  const url = () => TestBed.inject(Router).url;
  const stored = () => sessionStorage.getItem(JOIN_SECRET_KEY);

  beforeEach(() => {
    tokens = [];
    outcome = null;
    status = 'authenticated';
    welcome = false;
    replaced = [];
    sessionStorage.clear();
    const original = history.replaceState.bind(history);
    vi.spyOn(history, 'replaceState').mockImplementation((data, unused, target) => {
      replaced.push(String(target));
      original(data, unused, target);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('sends the secret of the fragment, takes it off the address and goes to Compras', async () => {
    await open(`/compras/convite#${SECRET}`);
    expect(tokens).toEqual([SECRET]);
    expect(replaced[0]).toBe(JOIN_PATH);
    expect(stored()).toBeNull();
    expect(url()).toBe('/compras');
  });

  it('without a session it keeps the secret in this tab and goes to the login with a clean next', async () => {
    status = 'anonymous';
    await open(`/compras/convite#${SECRET}`);
    expect(tokens).toEqual([]);
    expect(replaced[0]).toBe(JOIN_PATH);
    expect(url()).toBe('/entrar?next=%2Fcompras%2Fconvite');
    expect(url()).not.toContain(SECRET);
    expect(stored()).toBe(SECRET);
  });

  it('a new account answers the name first, without the secret in the address', async () => {
    welcome = true;
    await open(`/compras/convite#${SECRET}`);
    expect(tokens).toEqual([]);
    expect(url()).toBe('/boas-vindas?next=%2Fcompras%2Fconvite');
    expect(stored()).toBe(SECRET);
  });

  it('back from the login it reads the secret, erases it and then joins', async () => {
    sessionStorage.setItem(JOIN_SECRET_KEY, SECRET);
    await open('/compras/convite');
    expect(tokens).toEqual([SECRET]);
    expect(stored()).toBeNull();
    expect(url()).toBe('/compras');
  });

  it('a fresh link wins over a secret left in the tab', async () => {
    sessionStorage.setItem(JOIN_SECRET_KEY, OTHER);
    await open(`/compras/convite#${SECRET}`);
    expect(tokens).toEqual([SECRET]);
  });

  it('a fragment that is not a secret is dropped from the address and never stored', async () => {
    await open('/compras/convite#<script>');
    expect(replaced[0]).toBe(JOIN_PATH);
    expect(stored()).toBeNull();
    expect(tokens).toEqual([]);
  });

  it.each([
    [new ApiProblem(410, 'shopping-invite-invalid', 'x'), 'não vale mais'],
    [new ApiProblem(409, 'shopping-member-in-another-group', 'x'), 'Esvazie a sua'],
    [new ApiProblem(409, 'shopping-group-changed', 'x'), 'A situação mudou. Tente de novo.'],
    [new ApiProblem(403, 'forbidden', 'x'), 'ainda não usa as Compras'],
    [networkProblem(), 'Sem sinal'],
  ])('explains a refusal plainly (%s)', async (problem, message) => {
    outcome = problem;
    const el = await open(`/compras/convite#${SECRET}`);
    expect(el.textContent).toContain(message);
    // O roteador também esqueceu o fragmento: uma navegação que falhe não o devolve à barra.
    expect(url()).toBe(JOIN_PATH);
    expect(stored()).toBeNull();
  });

  it('retries with the same secret after a network failure', async () => {
    outcome = networkProblem();
    const el = await open(`/compras/convite#${SECRET}`);
    outcome = null;
    (el.querySelector('button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(tokens).toEqual([SECRET, SECRET]);
  });

  it('a group that changed under the request does not ask to empty a list, and offers to try again', async () => {
    outcome = new ApiProblem(409, 'shopping-group-changed', 'x');
    const el = await open(`/compras/convite#${SECRET}`);
    expect(el.textContent).not.toContain('Esvazie');
    outcome = null;
    (el.querySelector('button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(tokens).toEqual([SECRET, SECRET]);
  });

  it('without a secret it asks nothing of the server', async () => {
    const el = await open('/compras/convite');
    expect(tokens).toEqual([]);
    expect(el.textContent).toContain('não vale mais');
  });
});
