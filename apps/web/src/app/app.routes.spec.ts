import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { ApiProblem } from './core/auth/api-problem';
import { AuthApi } from './core/auth/auth-api';
import { FakeAccountScope } from './core/offline-queue/queue-test-kit';
import { AccountScope } from './core/session/account-scope';
import { HomeStatus, HomeStatusPort } from './core/status/home-status.port';

describe('app routes', () => {
  // Aqui não há sessão nem mock da API: o papel vem só da dica guardada no `localStorage`, que os arquivos de teste
  // dividem. Sem limpar, uma dica de "convidado" deixada por outro arquivo manda toda rota do administrador para a TV.
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        // O Treino só abre com uma conta conhecida (o banco local é por conta): estas rotas só olham o roteamento.
        { provide: AccountScope, useValue: new FakeAccountScope() },
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

  it('serves the public connector page outside the shell and without a session', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/conectar');
    expect(TestBed.inject(Router).url).toBe('/conectar');
    expect(harness.routeNativeElement?.matches('app-connect-page')).toBe(true);
  });

  it('sends an unknown screen of Configurações home', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/nada');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('redirects the saved devices address to Dispositivos', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/aparelhos');
    expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos');
    expect(harness.routeNativeElement?.querySelector('app-devices-page')).not.toBeNull();
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
  const TV = ['module:tv', 'tv:control'];
  const TRAINING = ['module:training'];
  // Telas só do dono: o convidado nunca as abre, qualquer que seja o módulo que a conta dele libera.
  const OWNER_ONLY = [
    '/ajustes/seguranca',
    '/ajustes/pessoas',
    '/ajustes/auditoria',
    '/ajustes/sistema',
    '/nada',
  ];

  /** A conta do convidado, com a lista de permissões que a API devolve (sem a lista: resposta antiga, não se sabe). */
  function signInAs(permissions?: string[]) {
    api.me.mockResolvedValue({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
      permissions,
    });
  }

  // O roteador de teste só aceita um "harness" por teste: vários endereços no mesmo teste reaproveitam o primeiro.
  let harness: RouterTestingHarness | undefined;

  async function go(url: string) {
    harness ??= await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return {
      url: TestBed.inject(Router).url,
      root: harness.routeNativeElement as HTMLElement,
    };
  }

  beforeEach(() => {
    harness = undefined;
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset();
    signInAs(TV);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: AuthApi, useValue: api },
        // O Treino só abre com uma conta conhecida (o banco local é por conta): estas rotas só olham o roteamento.
        { provide: AccountScope, useValue: new FakeAccountScope() },
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
    });
  });

  afterEach(() => localStorage.clear());

  describe('who only has the TV', () => {
    it.each([...OWNER_ONLY, '/treino', '/ajustes/creditos'])(
      'sends %s to Início: it is not a screen this guest may use',
      async (url) => {
        const { url: landed, root } = await go(url);
        expect(landed).toBe('/');
        expect(root.querySelector('app-home-page')).not.toBeNull();
      },
    );
  });

  describe('who only has the Treino', () => {
    it.each(OWNER_ONLY)('sends %s to Início, never through the TV', async (url) => {
      signInAs(TRAINING);
      const { url: landed, root } = await go(url);
      expect(landed).toBe('/');
      expect(root.querySelector('app-home-page')).not.toBeNull();
      expect(root.querySelector('app-tv-page')).toBeNull();
    });

    it.each([
      ['/treino', 'app-training-page'],
      ['/ajustes/creditos', 'app-credits-page'],
    ])('lets the guest open %s (%s)', async (url, selector) => {
      signInAs(TRAINING);
      const { url: landed, root } = await go(url);
      expect(landed).toBe(url);
      expect(root.matches('app-shell')).toBe(true);
      expect(root.querySelector(selector)).not.toBeNull();
    });

    it('has the round settings button in the Treino, with no way to the Início', async () => {
      signInAs(TRAINING);
      const { root } = await go('/treino');
      const header = root.querySelector('header')!;
      expect(header.querySelector('a[href="/"]')).toBeNull();
      expect(header.querySelectorAll('a')).toHaveLength(1);
      expect(header.querySelector('a')?.getAttribute('href')).toBe('/ajustes');
      expect(header.querySelector('a')?.getAttribute('aria-label')).toBe('Ajustes');
    });
  });

  it('does not let a guest with only Treino open the TV by address', async () => {
    signInAs(TRAINING);
    const { url, root } = await go('/tv');
    expect(url).toBe('/');
    expect(root.querySelector('app-home-page')).not.toBeNull();
  });

  describe('who has both modules', () => {
    it('starts on Início and may open the Treino too', async () => {
      signInAs([...TV, ...TRAINING]);
      expect((await go('/')).url).toBe('/');
      const { url, root } = await go('/treino');
      expect(url).toBe('/treino');
      expect(root.querySelector('app-training-page')).not.toBeNull();
    });
  });

  describe('who has no module at all', () => {
    it.each([...OWNER_ONLY, '/treino', '/ajustes/creditos'])(
      'sends %s to Início, not to a module',
      async (url) => {
        signInAs([]);
        const { url: landed, root } = await go(url);
        expect(landed).toBe('/');
        expect(root.querySelector('app-home-page')).not.toBeNull();
        expect(root.querySelector('app-tv-page, app-training-page')).toBeNull();
      },
    );
  });

  it('keeps Início as the home when the list of permissions is not known (an older answer)', async () => {
    signInAs(undefined);
    expect((await go('/')).url).toBe('/');
  });

  it('sends the old "no access" screen to Início when the guest does have a module', async () => {
    signInAs(TRAINING);
    expect((await go('/sem-acesso')).url).toBe('/');
  });

  it.each([
    ['/ajustes', 'app-settings-page'],
    ['/ajustes/perfil', 'app-profile-page'],
    ['/ajustes/aparencia', 'app-appearance-page'],
    ['/ajustes/sobre', 'app-about-page'],
  ])('lets the guest into %s (%s)', async (url, selector) => {
    const { url: landed, root } = await go(url);
    expect(landed).toBe(url);
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it('has the round settings button in the control (no tabs)', async () => {
    const { root } = await go('/tv');
    expect(root.querySelector('a[href="/"], app-tab-bar')).toBeNull();
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
