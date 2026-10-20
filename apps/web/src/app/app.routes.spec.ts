import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { AuthApi } from './core/auth/auth-api';

describe('app routes', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter(routes)] }));

  it.each([
    ['/', 'app-home-page'],
    ['/tv', 'app-tv-page'],
    ['/treino', 'app-training-page'],
    ['/ajustes', 'app-settings-page'],
  ])('%s renders %s inside the shell', async (url, selector) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it('serves the sign-in page outside the shell', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/entrar');
    expect(harness.routeNativeElement?.matches('app-login-page')).toBe(true);
  });

  it('sends unknown paths home', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/nada');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('serves the invite page outside the shell and without a session', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/convite');
    expect(harness.routeNativeElement?.matches('app-accept-invite-page')).toBe(true);
  });
});

describe('app routes for a guest', () => {
  const api = { refresh: vi.fn(), me: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me
      .mockReset()
      .mockResolvedValue({ id: '1', email: 'a@b.c', displayName: 'Alice', role: 'guest' });
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), { provide: AuthApi, useValue: api }],
    });
  });

  afterEach(() => localStorage.clear());

  it.each(['/', '/treino', '/ajustes', '/ajustes/aparelhos', '/ajustes/creditos', '/nada'])(
    'sends %s to the TV, the only screen of a guest',
    async (url) => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      expect(TestBed.inject(Router).url).toBe('/tv');
      expect(
        (harness.routeNativeElement as HTMLElement).querySelector('app-tv-page'),
      ).not.toBeNull();
    },
  );

  it('shows no navigation at all around the control', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('a[href="/"], app-tab-bar, header .back')).toBeNull();
  });
});
