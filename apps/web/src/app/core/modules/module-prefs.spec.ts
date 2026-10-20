import { TestBed } from '@angular/core/testing';
import { ModuleRegistry } from './module-registry';
import {
  MODULE_PREFS_KEY,
  ModulePrefs,
  WidgetPref,
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

describe('ModulePrefs', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

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
      MODULE_PREFS_KEY,
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
      MODULE_PREFS_KEY,
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
    localStorage.setItem(MODULE_PREFS_KEY, raw);
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
