import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiProblem, networkProblem } from './api-problem';
import { AuthApi } from './auth-api';
import { authGuard } from './auth.guard';

@Component({ template: '' })
class Inside {}
@Component({ template: '' })
class Login {}

describe('authGuard', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };

  beforeEach(() => {
    api.refresh.mockReset();
    api.me.mockReset().mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'A' });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Login },
          { path: 'tv', component: Inside, canMatch: [authGuard] },
          { path: '', component: Inside, canMatch: [authGuard] },
        ]),
        { provide: AuthApi, useValue: api },
      ],
    });
  });

  it('lets an authenticated session through', async () => {
    api.refresh.mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('sends an anonymous visitor to sign-in with the page they wanted as next', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    expect(TestBed.inject(Router).url).toBe('/entrar?next=%2Ftv');
  });

  it('keeps the query of the wanted page in next, so the sign-in can bring the visitor back to it', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv?codigo=BCDF-2345');
    expect(TestBed.inject(Router).url).toBe('/entrar?next=%2Ftv%3Fcodigo%3DBCDF-2345');
  });

  it('does not put the home page in next', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(TestBed.inject(Router).url).toBe('/entrar');
  });

  it('lets a pending session through (offline opens the shell, not the sign-in)', async () => {
    api.refresh.mockRejectedValue(networkProblem());
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('lets a pending session through when the API answers 404 (static test server)', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(404, '', 'x'));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    expect(TestBed.inject(Router).url).toBe('/tv');
  });
});
