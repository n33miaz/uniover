import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { ApiProblem } from './core/auth/api-problem';
import { AuthApi } from './core/auth/auth-api';
import { HomeStatus, HomeStatusPort } from './core/status/home-status.port';

describe('app routes', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        // A Início lê o estado da casa pela porta; aqui só interessa que a rota a desenha.
        {
          provide: HomeStatusPort,
          useValue: {
            status: signal<HomeStatus>({
              userName: null,
              agent: 'unknown',
              watcher: 'unknown',
              serviceDown: false,
            }),
            watch: () => () => undefined,
          },
        },
      ],
    }),
  );

  it.each([
    ['/', 'app-home-page'],
    ['/tv', 'app-tv-page'],
    ['/treino', 'app-training-page'],
    ['/ajustes', 'app-settings-page'],
    ['/ajustes/perfil', 'app-profile-page'],
    ['/ajustes/aparencia', 'app-appearance-page'],
    ['/ajustes/seguranca', 'app-security-page'],
    ['/ajustes/pessoas', 'app-people-page'],
    ['/ajustes/sobre', 'app-about-page'],
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

  it('sends an unknown screen of Ajustes home', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/nada');
    expect(TestBed.inject(Router).url).toBe('/');
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

  it.each([
    '/',
    '/treino',
    '/ajustes/seguranca',
    '/ajustes/pessoas',
    '/ajustes/aparelhos',
    '/ajustes/creditos',
    '/nada',
  ])('sends %s to the TV: it is not a screen a guest may use', async (url) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    expect(TestBed.inject(Router).url).toBe('/tv');
    expect((harness.routeNativeElement as HTMLElement).querySelector('app-tv-page')).not.toBeNull();
  });

  it.each([
    ['/ajustes', 'app-settings-page'],
    ['/ajustes/perfil', 'app-profile-page'],
    ['/ajustes/aparencia', 'app-appearance-page'],
    ['/ajustes/sobre', 'app-about-page'],
  ])('lets the guest into %s (%s)', async (url, selector) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    expect(TestBed.inject(Router).url).toBe(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it('has no way out of the control but the round settings button (no Início, no tabs)', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('a[href="/"], app-tab-bar, header .back')).toBeNull();
    const settings = root.querySelector('header.head a.settings');
    expect(settings?.getAttribute('href')).toBe('/ajustes');
    expect(settings?.getAttribute('aria-label')).toBe('Ajustes');
  });
});

describe('app routes for the first access', () => {
  const api = { refresh: vi.fn(), me: vi.fn(), updateMe: vi.fn() };
  const me = (role: string, confirmed: boolean) => ({
    id: '1',
    email: 'a@b.c',
    displayName: 'a',
    role,
    displayNameConfirmed: confirmed,
    permissions: [],
  });

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(me('owner', false));
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), { provide: AuthApi, useValue: api }],
    });
  });

  afterEach(() => localStorage.clear());

  it.each(['/', '/ajustes', '/ajustes/perfil', '/tv', '/treino'])(
    'asks the name before %s',
    async (url) => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      expect(TestBed.inject(Router).url).toBe(
        '/boas-vindas' + (url === '/' ? '' : '?next=' + encodeURIComponent(url)),
      );
      expect(harness.routeNativeElement?.matches('app-welcome-page')).toBe(true);
    },
  );

  it('asks the guest too, before the TV', async () => {
    api.me.mockResolvedValue(me('guest', false));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tv');
    expect(TestBed.inject(Router).url).toBe('/boas-vindas?next=%2Ftv');
  });

  it('serves the question outside the shell', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/boas-vindas');
    expect(harness.routeNativeElement?.matches('app-welcome-page')).toBe(true);
    expect(harness.routeNativeElement?.querySelector('app-shell')).toBeNull();
  });

  it('does not ask who already chose the name', async () => {
    api.me.mockResolvedValue(me('owner', true));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes');
    expect(TestBed.inject(Router).url).toBe('/ajustes');
  });

  it('sends the question to sign-in when there is no session', async () => {
    api.refresh.mockRejectedValue(new ApiProblem(401, '', 'x'));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/boas-vindas');
    expect(TestBed.inject(Router).url).toBe('/entrar');
  });
});
