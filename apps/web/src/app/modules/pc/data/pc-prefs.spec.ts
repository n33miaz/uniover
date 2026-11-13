import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { tick } from '../input/haptics';
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
    expect(prefs.sensitivity()).toBe(4);
    expect(prefs.invertScroll()).toBe(false);
    expect(prefs.customized()).toBe(false);
    expect(localStorage.getItem(pcPrefsStorageKey('pc-user'))).toBeNull();
  });

  it('keeps the gain and the scroll inversion for the next visit', () => {
    const prefs = fresh();
    prefs.set({ sensitivity: 6 });
    prefs.set({ invertScroll: true });
    expect(saved()).toMatchObject({ sensitivity: 6, invertScroll: true });
    expect(prefs.customized()).toBe(true);

    const next = fresh();
    expect(next.sensitivity()).toBe(6);
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
    expect(prefs.sensitivity()).toBe(6);
    expect(prefs.invertScroll()).toBe(true);
    expect(prefs.clickButtons()).toBe(false);
    expect(prefs.keepAwake()).toBe(true);
    expect(prefs.hintSeen()).toBe(false);
  });

  it('the first-use hint, once seen, stays seen and is not a choice', () => {
    const prefs = fresh();
    prefs.set({ hintSeen: true });
    expect(prefs.customized()).toBe(false);
    prefs.set({ sensitivity: 2 });
    prefs.reset();
    expect(prefs.hintSeen()).toBe(true);
    expect(fresh().hintSeen()).toBe(true);
  });

  it('the video warning is seen once, is not a choice, survives a reset and a reload', () => {
    const prefs = fresh();
    expect(prefs.videoHintSeen()).toBe(false);
    prefs.set({ videoHintSeen: true });
    expect(prefs.customized()).toBe(false);
    prefs.set({ haptics: false });
    prefs.reset();
    expect(prefs.videoHintSeen()).toBe(true);
    expect(fresh().videoHintSeen()).toBe(true);
  });

  it('the gesture choices start the way the owner asked and are kept', () => {
    const prefs = fresh();
    expect(prefs.scrollSensitivity()).toBe(4);
    expect(prefs.doubleTapDrag()).toBe(false);
    expect(prefs.middleClick()).toBe(true);
    expect(prefs.haptics()).toBe(true);
    prefs.set({
      scrollSensitivity: 6,
      doubleTapDrag: true,
      middleClick: false,
      haptics: false,
    });
    const next = fresh();
    expect(next.scrollSensitivity()).toBe(6);
    expect(next.doubleTapDrag()).toBe(true);
    expect(next.middleClick()).toBe(false);
    expect(next.haptics()).toBe(false);
    expect(next.customized()).toBe(true);
  });

  it('a scroll sensitivity that makes no sense goes back to normal', () => {
    localStorage.setItem(
      pcPrefsStorageKey('pc-user'),
      JSON.stringify({ scrollSensitivity: 'ludicrous', middleClick: 'yes' }),
    );
    const prefs = fresh();
    expect(prefs.scrollSensitivity()).toBe(4);
    expect(prefs.middleClick()).toBe(true);
  });

  it('turning the vibration off switches it off in the whole module', () => {
    const prefs = fresh();
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    // O jsdom não tem `matchMedia` (o `tick` o consulta para respeitar "reduzir movimento").
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({ matches: false }),
      configurable: true,
    });
    try {
      TestBed.tick();
      tick();
      expect(vibrate).toHaveBeenCalledTimes(1);
      prefs.set({ haptics: false });
      TestBed.tick();
      tick();
      expect(vibrate).toHaveBeenCalledTimes(1);
      prefs.set({ haptics: true });
      TestBed.tick();
    } finally {
      Reflect.deleteProperty(navigator, 'vibrate');
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('keeps one choice per person on this device', () => {
    fresh('ana').set({ sensitivity: 2 });
    const other = fresh('bia');
    expect(other.sensitivity()).toBe(4);
    expect(fresh('ana').sensitivity()).toBe(2);
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
    expect(prefs.sensitivity()).toBe(4);
    expect(prefs.invertScroll()).toBe(true);
  });

  it('survives corrupted storage and ignores an unknown choice', () => {
    localStorage.setItem(pcPrefsStorageKey('pc-user'), '{nao e json');
    const prefs = fresh();
    expect(prefs.sensitivity()).toBe(4);
    prefs.set({ sensitivity: 'nope' as never });
    expect(prefs.sensitivity()).toBe(4);
  });

  describe('migrating the choice saved before the slider', () => {
    const stored = (value: object) =>
      localStorage.setItem(pcPrefsStorageKey('pc-user'), JSON.stringify(value));

    it.each([
      ['low', 2, false],
      ['normal', 4, false],
      ['high', 6, false],
      ['boosted', 5, true],
    ] as const)('pointer %s becomes level %i (acceleration %s)', (old, level, acceleration) => {
      stored({ sensitivity: old, invertScroll: true });
      const prefs = fresh();
      expect(prefs.sensitivity()).toBe(level);
      expect(prefs.acceleration()).toBe(acceleration);
      expect(prefs.invertScroll()).toBe(true);
    });

    it.each([
      ['low', 2],
      ['normal', 4],
      ['high', 6],
    ] as const)('scroll %s becomes level %i', (old, level) => {
      stored({ scrollSensitivity: old });
      expect(fresh().scrollSensitivity()).toBe(level);
    });

    it('the old Normal is not a customization, Boosted is', () => {
      stored({ sensitivity: 'normal', scrollSensitivity: 'normal' });
      expect(fresh().customized()).toBe(false);
      stored({ sensitivity: 'boosted' });
      expect(fresh().customized()).toBe(true);
    });

    it('the next write saves the level as a number, keeping the other choices', () => {
      stored({ sensitivity: 'boosted', scrollSensitivity: 'high', middleClick: false });
      fresh().set({ invertScroll: true });
      expect(saved()).toMatchObject({
        sensitivity: 5,
        acceleration: true,
        scrollSensitivity: 6,
        middleClick: false,
        invertScroll: true,
      });
    });

    it.each([0, 8, 2.5, -1, '4', null])('a level of %s goes back to the middle', (bad) => {
      stored({ sensitivity: bad, scrollSensitivity: bad, acceleration: 'yes' });
      const prefs = fresh();
      expect(prefs.sensitivity()).toBe(4);
      expect(prefs.scrollSensitivity()).toBe(4);
      expect(prefs.acceleration()).toBe(false);
    });
  });

  it('showing the typed text is on by default and only the choice is kept', () => {
    const prefs = fresh();
    expect(prefs.showTyped()).toBe(true);
    prefs.set({ showTyped: false });
    expect(saved()).toMatchObject({ showTyped: false });
    expect(fresh().showTyped()).toBe(false);
  });

  it('reset returns to the defaults', () => {
    const prefs = fresh();
    prefs.set({ sensitivity: 7, acceleration: true, invertScroll: true });
    prefs.reset();
    expect(saved()).toEqual(PC_PREFS_DEFAULTS);
    expect(prefs.customized()).toBe(false);
  });

  it('still works for the session when the storage refuses to write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cheio');
    });
    const prefs = fresh();
    prefs.set({ sensitivity: 2 });
    expect(prefs.sensitivity()).toBe(2);
  });
});
