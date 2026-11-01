import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { routes } from './app.routes';
import { ApiProblem } from './core/auth/api-problem';
import { AuthApi } from './core/auth/auth-api';
import { OFFLINE_DB_FACTORY, OfflineDb } from './core/offline-queue/offline-db';
import { FakeAccountScope } from './core/offline-queue/queue-test-kit';
import { AccountScope } from './core/session/account-scope';
import { HomeStatus, HomeStatusPort } from './core/status/home-status.port';
import { TRAINING_DB_FACTORY, TrainingDb } from './modules/training/data/training-db';

/**
 * Os bancos locais da conta (fila offline e Treino) em memória. Sem isto o jsdom, que não tem IndexedDB, deixava a Dexie
 * rejeitar a abertura fora de qualquer teste ("IndexedDB API missing") assim que o shell sobe com uma conta conhecida.
 */
function inMemoryDatabases() {
  const options = { indexedDB: new FakeIDBFactory(), IDBKeyRange: FakeIDBKeyRange };
  return [
    { provide: OFFLINE_DB_FACTORY, useValue: (name: string) => new OfflineDb(name, options) },
    { provide: TRAINING_DB_FACTORY, useValue: (name: string) => new TrainingDb(name, options) },
  ];
}

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
        ...inMemoryDatabases(),
        // A Início lê o estado da casa pela porta; aqui só interessa que a rota a desenha.
        {
          provide: HomeStatusPort,
          useValue: {
            status: signal<HomeStatus>({
              userName: null,
              agent: 'unknown',
              watcher: 'unknown',
              serviceDown: false,
              agentLinked: null,
            }),
            loading: signal(false),
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

  it('redireciona o endereço antigo sem acesso para Início', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/sem-acesso');
    expect(TestBed.inject(Router).url).toBe('/');
    expect(harness.routeNativeElement?.querySelector('app-home-page')).not.toBeNull();
  });

  it('serves the invite page outside the shell and without a session', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/convite');
    expect(harness.routeNativeElement?.matches('app-accept-invite-page')).toBe(true);
  });
});

describe('app routes for a guest', () => {
  const api = { refresh: vi.fn(), me: vi.fn(), sessions: vi.fn() };
  const TV = ['module:tv', 'tv:control'];
  const TRAINING = ['module:training'];
  // Telas só do dono: o convidado nunca as abre, qualquer que seja o módulo que a conta dele libera.
  const OWNER_ONLY = ['/ajustes/pessoas', '/ajustes/auditoria', '/ajustes/sistema', '/nada'];

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
    api.sessions.mockReset().mockResolvedValue([]);
    signInAs(TV);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: AuthApi, useValue: api },
        // O Treino só abre com uma conta conhecida (o banco local é por conta): estas rotas só olham o roteamento.
        { provide: AccountScope, useValue: new FakeAccountScope() },
        ...inMemoryDatabases(),
        {
          provide: HomeStatusPort,
          useValue: {
            status: signal<HomeStatus>({
              userName: null,
              agent: 'unknown',
              watcher: 'unknown',
              serviceDown: false,
              agentLinked: null,
            }),
            loading: signal(false),
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

  describe('Segurança', () => {
    it.each([
      ['the TV', TV],
      ['the Treino', TRAINING],
    ])(
      'opens for a guest with %s, with the own sessions and no passkeys',
      async (_name, permissions) => {
        signInAs(permissions);
        const { url, root } = await go('/ajustes/seguranca');
        expect(url).toBe('/ajustes/seguranca');
        expect(root.querySelector('app-security-page')).not.toBeNull();
        expect(root.querySelector('app-sessions-section')).not.toBeNull();
        expect(root.querySelector('app-security-section')).toBeNull();
        expect(root.textContent).not.toContain('Passkeys');
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
      ['/treino', '/treino', 'app-training-page'],
      ['/ajustes/creditos', '/ajustes/sobre/creditos', 'app-credits-page'],
    ])('lets the guest open %s, which ends at %s (%s)', async (url, final, selector) => {
      signInAs(TRAINING);
      const { url: landed, root } = await go(url);
      expect(landed).toBe(final);
      expect(root.matches('app-shell')).toBe(true);
      expect(root.querySelector(selector)).not.toBeNull();
    });

    it('gives the guest one top arrow in the Treino header, and no second header or link of its own', async () => {
      signInAs(TRAINING);
      const { root } = await go('/treino');
      expect(root.querySelectorAll('app-page-top-bar')).toHaveLength(1);
      expect(root.querySelectorAll('app-page-top-bar .back')).toHaveLength(1);
      expect(root.querySelector('app-page-top-bar .back')?.getAttribute('aria-label')).toBe(
        'Voltar',
      );
      expect(root.querySelector('app-page-top-bar h1')?.textContent).toBe('Treino');
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

  it('has the Início arrow and no settings gear in the control header (no tabs)', async () => {
    const { root } = await go('/tv');
    expect(root.querySelector('a[href="/"]')?.getAttribute('aria-label')).toBe('Voltar ao Início');
    expect(root.querySelector('app-tab-bar')).toBeNull();
    // Configurações é só pela Início: o topo da TV não tem mais a engrenagem.
    expect(root.querySelector('header.head a.settings, header.head a[href="/ajustes"]')).toBeNull();
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
