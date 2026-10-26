import { TestBed } from '@angular/core/testing';
import { SessionState } from '../session/session-state';
import { ModuleRegistry } from './module-registry';
import {
  MODULE_PREFS_KEY,
  ModulePrefs,
  WidgetPref,
  modulePrefsStorageKey,
  moveWidget,
  moveWidgetTo,
} from './module-prefs';

const list: WidgetPref[] = [
  { id: 'a', size: 'small', enabled: true },
  { id: 'b', size: 'small', enabled: true },
  { id: 'c', size: 'small', enabled: true },
];

describe('moveWidget helpers', () => {
  it('moves up and down by one and stops at the ends', () => {
    expect(moveWidget(list, 'b', -1).map((w) => w.id)).toEqual(['b', 'a', 'c']);
    expect(moveWidget(list, 'b', 1).map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(moveWidget(list, 'a', -1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveWidget(list, 'c', 1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveWidget(list, 'x', 1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('moves to a position (drag)', () => {
    expect(moveWidgetTo(list, 'a', 2).map((w) => w.id)).toEqual(['b', 'c', 'a']);
    expect(moveWidgetTo(list, 'c', 0).map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(moveWidgetTo(list, 'a', 9).map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});

/** Identifica a conta que usa o aparelho (as escolhas são guardadas por conta). */
const identify = (id: string) =>
  TestBed.inject(SessionState).setUser({
    id,
    email: `${id}@example.com`,
    displayName: id,
    role: 'owner',
  });

describe('ModulePrefs', () => {
  const ACCOUNT = 'conta-1';
  const KEY = modulePrefsStorageKey(ACCOUNT);

  beforeEach(() => {
    localStorage.clear();
    identify(ACCOUNT);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // A conta identificada deixa dicas no armazenamento, que os outros arquivos de teste dividem.
    localStorage.clear();
  });

  const registryIds = () => TestBed.inject(ModuleRegistry).modules.map((m) => m.id);

  it('starts with the registry defaults, the planned modules shown and small', () => {
    const prefs = TestBed.inject(ModulePrefs);
    expect(prefs.widgets()).toEqual([
      { id: 'tv', size: 'small', enabled: true },
      { id: 'training', size: 'wide', enabled: true },
      { id: 'health', size: 'small', enabled: true },
      { id: 'monitor', size: 'small', enabled: true },
      { id: 'network', size: 'small', enabled: true },
      { id: 'backup', size: 'small', enabled: true },
      { id: 'notifications', size: 'small', enabled: true },
      { id: 'pc', size: 'small', enabled: true },
    ]);
  });

  it('keeps a preference saved before the planned modules existed and appends them at the end', () => {
    // O que um aparelho antigo guardou: só TV e Treino, na ordem e nos tamanhos que o dono escolheu.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'training', size: 'small', enabled: true },
        { id: 'tv', size: 'wide', enabled: false },
      ]),
    );
    const widgets = TestBed.inject(ModulePrefs).widgets();
    expect(widgets.slice(0, 2)).toEqual([
      { id: 'training', size: 'small', enabled: true },
      { id: 'tv', size: 'wide', enabled: false },
    ]);
    expect(widgets.slice(2).map((w) => [w.id, w.size, w.enabled])).toEqual(
      registryIds()
        .slice(2)
        .map((id) => [id, 'small', true]),
    );
  });

  it('saves on the device and restores in a new instance', () => {
    TestBed.inject(ModulePrefs).apply([
      { id: 'training', size: 'small', enabled: true },
      { id: 'tv', size: 'wide', enabled: true },
    ]);
    TestBed.resetTestingModule();
    expect(
      TestBed.inject(ModulePrefs)
        .widgets()
        .slice(0, 2)
        .map((w) => [w.id, w.size]),
    ).toEqual([
      ['training', 'small'],
      ['tv', 'wide'],
    ]);
  });

  it('hides a module that is turned off and brings it back', () => {
    const prefs = TestBed.inject(ModulePrefs);
    prefs.setEnabled('training', false);
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(
      registryIds().filter((id) => id !== 'training'),
    );
    prefs.setEnabled('training', true);
    expect(prefs.visible()).toHaveLength(registryIds().length);
  });

  it('appends modules missing from storage and drops unknown ones', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'ghost', size: 'small', enabled: true },
        { id: 'training', size: 'small', enabled: false },
      ]),
    );
    const ids = TestBed.inject(ModulePrefs)
      .widgets()
      .map((w) => w.id);
    expect(ids).toEqual(['training', ...registryIds().filter((id) => id !== 'training')]);
  });

  it.each(['not json', '{"a":1}', '[{"id":1}]'])('ignores corrupted storage (%s)', (raw) => {
    localStorage.setItem(KEY, raw);
    expect(TestBed.inject(ModulePrefs).widgets()).toHaveLength(registryIds().length);
  });

  it('keeps working when writing to storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cheio');
    });
    const prefs = TestBed.inject(ModulePrefs);
    expect(() => prefs.setEnabled('tv', false)).not.toThrow();
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(
      registryIds().filter((id) => id !== 'tv'),
    );
  });
});

describe('ModulePrefs per account', () => {
  const ids = (prefs: ModulePrefs) => prefs.widgets().map((w) => w.id);
  const registryIds = () => TestBed.inject(ModuleRegistry).modules.map((m) => m.id);

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('does not hand the choice of one account to the next one that signs in on the same page', () => {
    identify('conta-a');
    const prefs = TestBed.inject(ModulePrefs);
    prefs.setEnabled('tv', false);
    prefs.apply(moveWidget(prefs.widgets(), 'training', -1));
    expect(ids(prefs).slice(0, 2)).toEqual(['training', 'tv']);
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('tv');

    // A sai e B entra sem recarregar: o mesmo serviço, outra conta.
    TestBed.inject(SessionState).clear();
    identify('conta-b');
    expect(ids(prefs)).toEqual(registryIds());
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(registryIds());

    prefs.setEnabled('network', false);
    expect(
      JSON.parse(localStorage.getItem(modulePrefsStorageKey('conta-b')) ?? '[]'),
    ).toContainEqual(expect.objectContaining({ id: 'network', enabled: false }));

    // A volta: o que ela escolheu continua com ela, e o de B não vaza para cá.
    identify('conta-a');
    expect(ids(prefs).slice(0, 2)).toEqual(['training', 'tv']);
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('tv');
    expect(prefs.visible().map((w) => w.definition.id)).toContain('network');
  });

  it('does not hand the choice of one account to the next after the page is reloaded either', () => {
    identify('conta-a');
    TestBed.inject(ModulePrefs).setEnabled('tv', false);

    TestBed.resetTestingModule();
    identify('conta-b');
    expect(
      TestBed.inject(ModulePrefs)
        .visible()
        .map((w) => w.definition.id),
    ).toContain('tv');
  });

  it('discards the choice kept before there were accounts instead of giving it to whoever signs in first', () => {
    localStorage.setItem(
      MODULE_PREFS_KEY,
      JSON.stringify([{ id: 'tv', size: 'small', enabled: false }]),
    );
    identify('conta-a');
    const prefs = TestBed.inject(ModulePrefs);
    expect(prefs.visible().map((w) => w.definition.id)).toContain('tv');
    expect(localStorage.getItem(MODULE_PREFS_KEY)).toBeNull();
    expect(localStorage.getItem(modulePrefsStorageKey('conta-a'))).toBeNull();

    identify('conta-b');
    expect(prefs.visible().map((w) => w.definition.id)).toContain('tv');
    expect(localStorage.getItem(MODULE_PREFS_KEY)).toBeNull();
  });

  it('restores the saved order after a reload that starts offline, from the account hint alone', () => {
    identify('conta-a');
    const first = TestBed.inject(ModulePrefs);
    first.apply(moveWidget(first.widgets(), 'training', -1));

    // Recarrega sem rede: nenhum `/me` chegou, só a dica da conta da última sessão está no aparelho.
    TestBed.resetTestingModule();
    expect(localStorage.getItem('uniover.account-id')).toBe('conta-a');
    expect(ids(TestBed.inject(ModulePrefs)).slice(0, 2)).toEqual(['training', 'tv']);
  });

  it('reads the saved order of the account when it is only confirmed after the service exists', () => {
    localStorage.setItem(
      modulePrefsStorageKey('conta-a'),
      JSON.stringify([
        { id: 'training', size: 'wide', enabled: true },
        { id: 'tv', size: 'small', enabled: true },
      ]),
    );
    const prefs = TestBed.inject(ModulePrefs);
    expect(ids(prefs)).toEqual(registryIds());

    identify('conta-a');
    expect(ids(prefs).slice(0, 2)).toEqual(['training', 'tv']);
  });

  it('shows the defaults and saves nothing while no account is known, then uses the account when it arrives', () => {
    const prefs = TestBed.inject(ModulePrefs);
    expect(ids(prefs)).toEqual(registryIds());
    prefs.setEnabled('tv', false);
    expect(prefs.visible().map((w) => w.definition.id)).not.toContain('tv');
    expect(Object.keys(localStorage).filter((key) => key.startsWith(MODULE_PREFS_KEY))).toEqual([]);

    identify('conta-a');
    expect(prefs.visible().map((w) => w.definition.id)).toContain('tv');
  });
});
