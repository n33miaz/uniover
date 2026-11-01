import { TestBed } from '@angular/core/testing';
import { SessionState } from '../session/session-state';
import { ModuleRegistry } from './module-registry';
import { ModulePrefs, WidgetPref, modulePrefsStorageKey, modulePrefsSyncKey } from './module-prefs';
import { AccountPreferences, HomeEntry, PreferencesApi, SaveOutcome } from './preferences-api';

/** Um JWT só com o `sub` (o app só lê o payload para saber de quem é o token; quem valida é a API). */
function jwtOf(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none' })}.${part({ sub })}.assinatura`;
}

/** A API de preferências em memória, com a mesma regra de versão da real. */
class FakeApi {
  remote: AccountPreferences = { version: 0, updatedAt: null, home: null };
  readFails = false;
  saveFails = false;
  gets = 0;
  readonly saves: { base: number; home: readonly HomeEntry[] | null }[] = [];
  /** Se definido, a leitura espera por ele (para trocar de conta no meio do voo). */
  hold: Promise<void> | null = null;

  async get(): Promise<AccountPreferences> {
    this.gets++;
    const snapshot = structuredClone(this.remote);
    if (this.hold) await this.hold;
    if (this.readFails) throw new Error('sem rede');
    return snapshot;
  }

  async save(base: number, home: readonly HomeEntry[] | null): Promise<SaveOutcome> {
    this.saves.push({ base, home });
    if (this.saveFails) throw new Error('sem rede');
    if (base !== this.remote.version) {
      return { saved: false, current: structuredClone(this.remote) };
    }
    this.remote = {
      version: base + 1,
      updatedAt: '2026-10-31T12:00:00Z',
      home: structuredClone(home),
    };
    return { saved: true, current: structuredClone(this.remote) };
  }
}

const A = 'conta-a';
const B = 'conta-b';

describe('ModulePrefs sync with the account', () => {
  let api: FakeApi;

  beforeEach(() => {
    localStorage.clear();
    api = new FakeApi();
    TestBed.configureTestingModule({ providers: [{ provide: PreferencesApi, useValue: api }] });
  });
  afterEach(() => {
    localStorage.clear();
  });

  const session = () => TestBed.inject(SessionState);
  const registryIds = () => TestBed.inject(ModuleRegistry).modules.map((m) => m.id);
  const meta = (account: string) =>
    JSON.parse(localStorage.getItem(modulePrefsSyncKey(account)) ?? 'null') as {
      version: number;
      dirty: boolean;
    } | null;
  const local = (account: string) =>
    JSON.parse(localStorage.getItem(modulePrefsStorageKey(account)) ?? 'null') as
      WidgetPref[] | null;

  /** Entra na conta com a sessão confirmada (token e `/me`), como o app faz, e deixa o efeito de sincronização rodar. */
  function signIn(account: string): void {
    session().setToken(jwtOf(account), 600);
    session().setUser({
      id: account,
      email: `${account}@exemplo.com`,
      displayName: account,
      role: 'owner',
    });
    TestBed.tick();
  }

  /** Espera a fila de sincronização esvaziar (as promessas do app não são expostas, então só se observa o efeito). */
  const settled = () => vi.waitFor(() => expect(api.gets).toBeGreaterThan(0)).then(() => flush());
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  const goOnline = () => window.dispatchEvent(new Event('online'));

  it('adopts the choice of the account on sign-in and keeps it as the local copy', async () => {
    api.remote = {
      version: 3,
      updatedAt: '2026-10-30T10:00:00Z',
      home: [
        { id: 'training', enabled: true },
        { id: 'tv', enabled: false },
      ],
    };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    expect(prefs.widgets().slice(0, 2)).toEqual([
      { id: 'training', size: 'small', enabled: true },
      { id: 'tv', size: 'small', enabled: false },
    ]);
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('tv');
    expect(local(A)).toEqual([
      { id: 'training', size: 'small', enabled: true },
      { id: 'tv', size: 'small', enabled: false },
    ]);
    expect(meta(A)).toEqual({ version: 3, dirty: false });
    expect(api.saves).toEqual([]);
  });

  it('migrates what the device already had, once, when the account has nothing yet', async () => {
    localStorage.setItem(
      modulePrefsStorageKey(A),
      JSON.stringify([
        { id: 'training', size: 'small', enabled: true },
        { id: 'tv', size: 'small', enabled: false },
      ]),
    );
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    expect(api.saves).toHaveLength(1);
    expect(api.saves[0].base).toBe(0);
    expect(api.saves[0].home?.slice(0, 2)).toEqual([
      { id: 'training', enabled: true },
      { id: 'tv', enabled: false },
    ]);
    expect(api.remote.version).toBe(1);
    expect(meta(A)).toEqual({ version: 1, dirty: false });

    // Nova entrada e a conexão voltando: nada sobe de novo (a migração foi uma só).
    goOnline();
    await flush();
    goOnline();
    await flush();
    expect(api.saves).toHaveLength(1);
    expect(prefs.widgets()[0].id).toBe('training');
  });

  it('lets the account win over the device when both have a choice', async () => {
    localStorage.setItem(
      modulePrefsStorageKey(A),
      JSON.stringify([{ id: 'tv', size: 'small', enabled: false }]),
    );
    api.remote = { version: 2, updatedAt: null, home: [{ id: 'monitor', enabled: false }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    expect(api.saves).toEqual([]);
    expect(prefs.visible().map((w) => w.definition.id)).toContain('tv');
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('monitor');
  });

  it('sends nothing when neither side has a choice, and remembers the version it read', async () => {
    TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    expect(api.saves).toEqual([]);
    expect(meta(A)).toEqual({ version: 0, dirty: false });
    expect(local(A)).toBeNull();
  });

  it('keeps using the local copy when the account cannot be read, and syncs when the connection is back', async () => {
    localStorage.setItem(
      modulePrefsStorageKey(A),
      JSON.stringify([{ id: 'training', size: 'small', enabled: true }]),
    );
    api.readFails = true;
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    expect(prefs.widgets()[0].id).toBe('training');
    expect(api.saves).toEqual([]);
    expect(meta(A)).toBeNull();

    api.readFails = false;
    goOnline();
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));
    expect(api.remote.home?.[0]).toEqual({ id: 'training', enabled: true });
  });

  it('sends a choice saved in Personalizar over the version it read', async () => {
    api.remote = { version: 2, updatedAt: null, home: [{ id: 'tv', enabled: true }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    prefs.setEnabled('tv', false);
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));

    expect(api.saves[0].base).toBe(2);
    expect(api.saves[0].home?.find((e) => e.id === 'tv')).toEqual({ id: 'tv', enabled: false });
    await flush();
    expect(meta(A)).toEqual({ version: 3, dirty: false });
    expect(local(A)?.find((p) => p.id === 'tv')?.enabled).toBe(false);
  });

  it('applies on the device at once and keeps the save pending while offline, sending it on the next sync', async () => {
    api.remote = { version: 1, updatedAt: null, home: [{ id: 'tv', enabled: true }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    api.saveFails = true;
    prefs.setEnabled('training', false);
    // Já vale na tela e no aparelho, antes de qualquer resposta.
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('training');
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));
    await flush();
    expect(meta(A)).toEqual({ version: 1, dirty: true });
    expect(api.remote.version).toBe(1);

    api.saveFails = false;
    goOnline();
    await vi.waitFor(() => expect(api.remote.version).toBe(2));
    expect(api.remote.home?.find((e) => e.id === 'training')?.enabled).toBe(false);
    expect(meta(A)).toEqual({ version: 2, dirty: false });
  });

  it('adopts the choice of the account when another device saved first (version mismatch)', async () => {
    api.remote = { version: 1, updatedAt: null, home: [{ id: 'tv', enabled: true }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    // Outro aparelho grava antes: a conta vai para a versão 2 sem este aparelho saber.
    api.remote = {
      version: 2,
      updatedAt: null,
      home: [
        { id: 'monitor', enabled: false },
        { id: 'tv', enabled: true },
      ],
    };
    prefs.setEnabled('training', false);
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));
    await flush();

    expect(api.remote.version).toBe(2);
    expect(prefs.widgets()[0]).toEqual({ id: 'monitor', size: 'small', enabled: false });
    expect(prefs.visible().map((w) => w.definition.id)).toContain('training');
    expect(meta(A)).toEqual({ version: 2, dirty: false });
  });

  it('drops a pending change when the account moved on to a newer version meanwhile', async () => {
    api.remote = { version: 1, updatedAt: null, home: [{ id: 'tv', enabled: true }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();
    api.saveFails = true;
    prefs.setEnabled('training', false);
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));
    await flush();
    expect(meta(A)?.dirty).toBe(true);

    api.saveFails = false;
    api.remote = { version: 5, updatedAt: null, home: [{ id: 'network', enabled: false }] };
    goOnline();
    await vi.waitFor(() => expect(meta(A)).toEqual({ version: 5, dirty: false }));

    expect(api.saves).toHaveLength(1);
    expect(prefs.widgets()[0].id).toBe('network');
  });

  it('never sends a module id the API would refuse', async () => {
    api.remote = { version: 1, updatedAt: null, home: [{ id: 'tv', enabled: true }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();

    prefs.apply([
      { id: 'tv', size: 'small', enabled: true },
      { id: 'Id Estranho!', size: 'small', enabled: true },
    ]);
    await vi.waitFor(() => expect(api.saves).toHaveLength(1));

    expect(api.saves[0].home).toEqual([{ id: 'tv', enabled: true }]);
  });

  it('does not talk to the API before the session is confirmed', async () => {
    const prefs = TestBed.inject(ModulePrefs);
    session().setUser({ id: A, email: 'a@exemplo.com', displayName: A, role: 'owner' });
    TestBed.tick();
    prefs.setEnabled('tv', false);
    await flush();

    expect(api.gets).toBe(0);
    expect(api.saves).toEqual([]);
    // A escolha vale no aparelho e fica pendente para quando a sessão se confirmar.
    expect(local(A)?.find((p) => p.id === 'tv')?.enabled).toBe(false);
    expect(meta(A)?.dirty).toBe(true);
  });

  it('ignores an answer that arrives after the account changed', async () => {
    api.remote = { version: 4, updatedAt: null, home: [{ id: 'tv', enabled: false }] };
    let release!: () => void;
    api.hold = new Promise<void>((resolve) => (release = resolve));
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await vi.waitFor(() => expect(api.gets).toBe(1));

    // A sessão passa para outra conta enquanto a leitura da primeira está no ar.
    session().clear();
    session().setToken(jwtOf(B), 600);
    session().setUser({ id: B, email: 'b@exemplo.com', displayName: B, role: 'owner' });
    api.remote = { version: 0, updatedAt: null, home: null };
    api.hold = null;
    TestBed.tick();
    release();
    await vi.waitFor(() => expect(api.gets).toBe(2));
    await flush();

    expect(local(A)).toBeNull();
    expect(meta(A)).toBeNull();
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(registryIds());
  });

  it('keeps each account sync state apart when two accounts use the same device', async () => {
    api.remote = { version: 2, updatedAt: null, home: [{ id: 'tv', enabled: false }] };
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await settled();
    expect(meta(A)).toEqual({ version: 2, dirty: false });

    session().clear();
    api.remote = { version: 0, updatedAt: null, home: null };
    signIn(B);
    await vi.waitFor(() => expect(meta(B)).toEqual({ version: 0, dirty: false }));

    expect(prefs.visible().map((w) => w.definition.id)).toContain('tv');
    expect(meta(A)).toEqual({ version: 2, dirty: false });
  });

  it('survives an API that answers with something unexpected', async () => {
    const bad = {
      get: () => Promise.reject(new Error('Resposta de preferências inesperada.')),
      save: () => Promise.reject(new Error('x')),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PreferencesApi, useValue: bad }] });
    const prefs = TestBed.inject(ModulePrefs);
    signIn(A);
    await flush();
    prefs.setEnabled('tv', false);
    await flush();

    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('tv');
  });
});
