import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { PC_PREFS_DEFAULTS, PcPrefs, pcPrefsStorageKey } from './pc-prefs';

describe('PcPrefs', () => {
  const identify = (id = 'pc-user') =>
    TestBed.inject(SessionState).setUser({ id, email: `${id}@example.com`, displayName: 'PC' });
  const fresh = (id = 'pc-user') => {
    TestBed.resetTestingModule();
    identify(id);
    return TestBed.inject(PcPrefs);
  };
  const saved = (id = 'pc-user') =>
    JSON.parse(localStorage.getItem(pcPrefsStorageKey(id)) ?? 'null');

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts with no extra acceleration and the Windows scroll direction, writing nothing', () => {
    const prefs = fresh();
    expect(prefs.sensitivity()).toBe('normal');
    expect(prefs.invertScroll()).toBe(false);
    expect(prefs.customized()).toBe(false);
    expect(localStorage.getItem(pcPrefsStorageKey('pc-user'))).toBeNull();
  });

  it('keeps the gain and the scroll inversion for the next visit', () => {
    const prefs = fresh();
    prefs.set({ sensitivity: 'high' });
    prefs.set({ invertScroll: true });
    expect(saved()).toMatchObject({ sensitivity: 'high', invertScroll: true });
    expect(prefs.customized()).toBe(true);

    const next = fresh();
    expect(next.sensitivity()).toBe('high');
    expect(next.invertScroll()).toBe(true);
  });

  it('shows the click buttons off and keeps the screen awake by default, and keeps what is chosen', () => {
    const prefs = fresh();
    expect(prefs.clickButtons()).toBe(false);
    expect(prefs.keepAwake()).toBe(true);
    prefs.set({ clickButtons: true, keepAwake: false });
    const next = fresh();
    expect(next.clickButtons()).toBe(true);
    expect(next.keepAwake()).toBe(false);
    expect(next.customized()).toBe(true);
  });

  it('a value stored by the previous version still reads, with the new fields at their defaults', () => {
    localStorage.setItem(
      pcPrefsStorageKey('pc-user'),
      JSON.stringify({ sensitivity: 'high', invertScroll: true }),
    );
    const prefs = fresh();
    expect(prefs.sensitivity()).toBe('high');
    expect(prefs.invertScroll()).toBe(true);
    expect(prefs.clickButtons()).toBe(false);
    expect(prefs.keepAwake()).toBe(true);
    expect(prefs.hintSeen()).toBe(false);
  });

  it('the first-use hint, once seen, stays seen and is not a choice', () => {
    const prefs = fresh();
    prefs.set({ hintSeen: true });
    expect(prefs.customized()).toBe(false);
    prefs.set({ sensitivity: 'low' });
    prefs.reset();
    expect(prefs.hintSeen()).toBe(true);
    expect(fresh().hintSeen()).toBe(true);
  });

  it('keeps one choice per person on this device', () => {
    fresh('ana').set({ sensitivity: 'low' });
    const other = fresh('bia');
    expect(other.sensitivity()).toBe('normal');
    expect(fresh('ana').sensitivity()).toBe('low');
  });

  it('follows the account when it changes without a reload', () => {
    const prefs = fresh('ana');
    prefs.set({ invertScroll: true });
    identify('bia');
    expect(prefs.invertScroll()).toBe(false);
    identify('ana');
    expect(prefs.invertScroll()).toBe(true);
  });

  it('a stored value that makes no sense goes back to the default, field by field', () => {
    localStorage.setItem(
      pcPrefsStorageKey('pc-user'),
      JSON.stringify({ sensitivity: 'ludicrous', invertScroll: true }),
    );
    const prefs = fresh();
    expect(prefs.sensitivity()).toBe('normal');
    expect(prefs.invertScroll()).toBe(true);
  });

  it('survives corrupted storage and ignores an unknown choice', () => {
    localStorage.setItem(pcPrefsStorageKey('pc-user'), '{nao e json');
    const prefs = fresh();
    expect(prefs.sensitivity()).toBe('normal');
    prefs.set({ sensitivity: 'nope' as never });
    expect(prefs.sensitivity()).toBe('normal');
  });

  it('reset returns to the defaults', () => {
    const prefs = fresh();
    prefs.set({ sensitivity: 'boosted', invertScroll: true });
    prefs.reset();
    expect(saved()).toEqual(PC_PREFS_DEFAULTS);
    expect(prefs.customized()).toBe(false);
  });

  it('still works for the session when the storage refuses to write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cheio');
    });
    const prefs = fresh();
    prefs.set({ sensitivity: 'low' });
    expect(prefs.sensitivity()).toBe('low');
  });
});
