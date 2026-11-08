import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { PcPinned, pcPinnedStorageKey } from './pc-pinned';
import { DEFAULT_PINNED, MAX_PINNED, SHORTCUTS } from './pc-shortcuts';

describe('PcPinned', () => {
  const identify = (id = 'pc-user') =>
    TestBed.inject(SessionState).setUser({ id, email: `${id}@example.com`, displayName: 'PC' });
  const fresh = (id = 'pc-user') => {
    TestBed.resetTestingModule();
    identify(id);
    return TestBed.inject(PcPinned);
  };
  const saved = (id = 'pc-user') =>
    JSON.parse(localStorage.getItem(pcPinnedStorageKey(id)) ?? 'null');

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts with the default pinned shortcuts and writes nothing', () => {
    const pinned = fresh();
    expect(pinned.ids()).toEqual(DEFAULT_PINNED);
    expect(pinned.shortcuts().map((shortcut) => shortcut.id)).toEqual([...DEFAULT_PINNED]);
    expect(localStorage.getItem(pcPinnedStorageKey('pc-user'))).toBeNull();
  });

  it('pins and unpins, keeping the order of pinning, and remembers it for the next visit', () => {
    const pinned = fresh();
    expect(pinned.toggle('save')).toBe(true);
    expect(pinned.isPinned('save')).toBe(true);
    expect(pinned.toggle('copy')).toBe(true);
    expect(pinned.isPinned('copy')).toBe(false);
    expect(saved()).toEqual([...DEFAULT_PINNED.filter((id) => id !== 'copy'), 'save']);

    const next = fresh();
    expect(next.isPinned('save')).toBe(true);
    expect(next.isPinned('copy')).toBe(false);
    expect(next.ids().at(-1)).toBe('save');
  });

  it('stops at the limit, says so, and a freed place can be taken again', () => {
    const pinned = fresh();
    const rest = SHORTCUTS.map((shortcut) => shortcut.id).filter((id) => !pinned.isPinned(id));
    for (const id of rest.slice(0, MAX_PINNED - DEFAULT_PINNED.length))
      expect(pinned.toggle(id)).toBe(true);
    expect(pinned.ids()).toHaveLength(MAX_PINNED);
    expect(pinned.full()).toBe(true);
    expect(pinned.toggle(rest.at(-1)!)).toBe(false);
    expect(pinned.isPinned(rest.at(-1)!)).toBe(false);
    expect(pinned.toggle('copy')).toBe(true);
    expect(pinned.full()).toBe(false);
    expect(pinned.toggle(rest.at(-1)!)).toBe(true);
  });

  it('ignores an id that is not in the catalog', () => {
    const pinned = fresh();
    expect(pinned.toggle('does-not-exist')).toBe(false);
    expect(pinned.ids()).toEqual(DEFAULT_PINNED);
  });

  it('can pin nothing at all, and that is remembered (it is not the default)', () => {
    const pinned = fresh();
    for (const id of DEFAULT_PINNED) pinned.toggle(id);
    expect(pinned.ids()).toEqual([]);
    expect(fresh().ids()).toEqual([]);
  });

  it('keeps one choice per person on this device', () => {
    fresh('ana').toggle('save');
    expect(fresh('bia').isPinned('save')).toBe(false);
    expect(fresh('ana').isPinned('save')).toBe(true);
  });

  it('follows the account when it changes without a reload', () => {
    const pinned = fresh('ana');
    pinned.toggle('save');
    identify('bia');
    expect(pinned.isPinned('save')).toBe(false);
    identify('ana');
    expect(pinned.isPinned('save')).toBe(true);
  });

  it('drops, when reading, an id that left the catalog, a repeat, and anything that is not an id', () => {
    localStorage.setItem(
      pcPinnedStorageKey('pc-user'),
      JSON.stringify(['paste', 'gone-in-a-new-version', 'paste', 42, null, 'save']),
    );
    expect(fresh().ids()).toEqual(['paste', 'save']);
  });

  it('keeps no more than the limit when reading', () => {
    localStorage.setItem(
      pcPinnedStorageKey('pc-user'),
      JSON.stringify(SHORTCUTS.map((shortcut) => shortcut.id)),
    );
    expect(fresh().ids()).toHaveLength(MAX_PINNED);
  });

  it('goes back to the default for something that is not a list, and for corrupted storage', () => {
    localStorage.setItem(pcPinnedStorageKey('pc-user'), JSON.stringify({ copy: true }));
    expect(fresh().ids()).toEqual(DEFAULT_PINNED);
    localStorage.setItem(pcPinnedStorageKey('pc-user'), '{nao e json');
    expect(fresh().ids()).toEqual(DEFAULT_PINNED);
  });

  it('reset returns to the default', () => {
    const pinned = fresh();
    pinned.toggle('save');
    pinned.reset();
    expect(pinned.ids()).toEqual(DEFAULT_PINNED);
    expect(saved()).toEqual([...DEFAULT_PINNED]);
  });

  it('still works for the session when the storage refuses to write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cheio');
    });
    const pinned = fresh();
    expect(pinned.toggle('save')).toBe(true);
    expect(pinned.isPinned('save')).toBe(true);
  });
});
