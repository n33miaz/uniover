import { TestBed } from '@angular/core/testing';
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

  it('starts with the registry defaults', () => {
    const prefs = TestBed.inject(ModulePrefs);
    expect(prefs.widgets()).toEqual([
      { id: 'tv', size: 'small', enabled: true },
      { id: 'training', size: 'wide', enabled: true },
    ]);
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
        .map((w) => [w.id, w.size]),
    ).toEqual([
      ['training', 'small'],
      ['tv', 'wide'],
    ]);
  });

  it('hides a module that is turned off and brings it back', () => {
    const prefs = TestBed.inject(ModulePrefs);
    prefs.setEnabled('training', false);
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(['tv']);
    prefs.setEnabled('training', true);
    expect(prefs.visible()).toHaveLength(2);
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
    expect(ids).toEqual(['training', 'tv']);
  });

  it.each(['not json', '{"a":1}', '[{"id":1}]'])('ignores corrupted storage (%s)', (raw) => {
    localStorage.setItem(MODULE_PREFS_KEY, raw);
    expect(TestBed.inject(ModulePrefs).widgets()).toHaveLength(2);
  });

  it('keeps working when writing to storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cheio');
    });
    const prefs = TestBed.inject(ModulePrefs);
    expect(() => prefs.setEnabled('tv', false)).not.toThrow();
    expect(prefs.visible().map((w) => w.definition.id)).toEqual(['training']);
  });
});
