import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { ShoppingJoinPage } from './shopping-join.page';
import { ShoppingPeopleApi } from './shopping-people-api';

@Component({ template: '' })
class Blank {}

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

describe('ShoppingJoinPage', () => {
  let tokens: string[];
  let outcome: unknown;

  async function open(url: string): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'compras/convite', component: ShoppingJoinPage },
          { path: 'compras', component: Blank },
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
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    tokens = [];
    outcome = null;
  });

  it('sends the secret of the fragment, takes it off the address and goes to Compras', async () => {
    await open(`/compras/convite#${SECRET}`);
    expect(tokens).toEqual([SECRET]);
    expect(TestBed.inject(Router).url).toBe('/compras');
  });

  it.each([
    [new ApiProblem(410, 'shopping-invite-invalid', 'x'), 'não vale mais'],
    [new ApiProblem(409, 'shopping-member-in-another-group', 'x'), 'Esvazie a sua'],
    [new ApiProblem(403, 'forbidden', 'x'), 'ainda não usa as Compras'],
    [networkProblem(), 'Sem sinal'],
  ])('explains a refusal plainly (%s)', async (problem, message) => {
    outcome = problem;
    const el = await open(`/compras/convite#${SECRET}`);
    expect(el.textContent).toContain(message);
    expect(TestBed.inject(Router).url).toBe('/compras/convite');
  });

  it('without a secret it asks nothing of the server', async () => {
    const el = await open('/compras/convite');
    expect(tokens).toEqual([]);
    expect(el.textContent).toContain('não vale mais');
  });
});
