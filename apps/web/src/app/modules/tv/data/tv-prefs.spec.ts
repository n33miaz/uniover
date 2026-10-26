import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import {
  KEY_SCALE,
  TV_NAME_MAX,
  TV_PREFS_KEY,
  TvPrefs,
  tvLayoutCacheKey,
  tvPrefsStorageKey,
} from './tv-prefs';
import { TvSelection, tvSelectedStorageKey } from './tv-selection';

describe('TvPrefs', () => {
  const identify = (id = 'tv-user') =>
    TestBed.inject(SessionState).setUser({ id, email: `${id}@example.com`, displayName: 'TV' });
  const fresh = () => {
    TestBed.resetTestingModule();
    identify();
    return TestBed.inject(TvPrefs);
  };
  const accountKey = () => tvPrefsStorageKey('tv-user');
  const saved = () => JSON.parse(localStorage.getItem(accountKey()) ?? 'null');

  beforeEach(() => {
    localStorage.clear();
    identify();
  });
  afterEach(() => {
    // O espelho da vibração é um módulo só: devolve ao padrão para o próximo teste.
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts with the defaults and writes nothing until something changes', () => {
    const prefs = fresh();
    expect(prefs.name()).toBe('');
    expect(prefs.title()).toBe('TV');
    expect(prefs.buttonSize()).toBe('comfortable');
    expect(prefs.keyScale()).toBe(1);
    expect(prefs.showMedia()).toBe(true);
    expect(prefs.showChannel()).toBe(true);
    expect(prefs.vibration()).toBe(true);
    expect(prefs.startPage()).toBe('last');
    expect(prefs.padSpeed()).toBe('normal');
    expect(prefs.pillLayout()).toBe('sides');
    expect(prefs.customized()).toBe(false);
    expect(localStorage.getItem(accountKey())).toBeNull();
  });

  it('keeps every choice for the next visit', () => {
    const prefs = fresh();
    prefs.set({
      name: 'Sala',
      buttonSize: 'large',
      showMedia: false,
      showChannel: false,
      vibration: false,
      startPage: 'numbers',
      padSpeed: 'fast',
      pillLayout: 'row',
      extraKeys: ['GUIDE', 'BLUE'],
      dismissedSuggestions: ['netflix'],
    });
    expect(saved()).toEqual({
      name: 'Sala',
      buttonSize: 'large',
      showMedia: false,
      showChannel: false,
      vibration: false,
      startPage: 'numbers',
      padSpeed: 'fast',
      pillLayout: 'row',
      extraKeys: ['GUIDE', 'BLUE'],
      dismissedSuggestions: ['netflix'],
    });

    const again = fresh();
    expect(again.title()).toBe('Sala');
    expect(again.buttonSize()).toBe('large');
    expect(again.keyScale()).toBe(KEY_SCALE.large);
    expect(again.showMedia()).toBe(false);
    expect(again.showChannel()).toBe(false);
    expect(again.vibration()).toBe(false);
    expect(again.startPage()).toBe('numbers');
    expect(again.padSpeed()).toBe('fast');
    expect(again.pillLayout()).toBe('row');
    expect(again.dismissedSuggestions()).toEqual(['netflix']);
    expect(again.customized()).toBe(true);
  });

  describe('extra buttons', () => {
    it('start automatic: nothing chosen, so the important keys fill the empty cells', () => {
      localStorage.setItem(accountKey(), JSON.stringify({ name: '' }));
      const prefs = fresh();
      expect(prefs.extraKeys()).toBeNull();
      expect(prefs.customized()).toBe(false);
    });

    it('keep the chosen keys in order, count as a customization and go back with "Restaurar padrão"', () => {
      const prefs = fresh();
      prefs.set({ extraKeys: ['GUIDE', 'RED'] });
      expect(fresh().extraKeys()).toEqual(['GUIDE', 'RED']);
      expect(prefs.customized()).toBe(true);
      prefs.reset();
      expect(prefs.extraKeys()).toBeNull();
      expect(prefs.customized()).toBe(false);
    });

    it('can be an empty choice (no extras at all), which is not the automatic one', () => {
      const prefs = fresh();
      prefs.set({ extraKeys: [] });
      expect(fresh().extraKeys()).toEqual([]);
      expect(prefs.customized()).toBe(true);
    });

    it('drop what the app has no button for, repeats and anything past the main screen limit', () => {
      localStorage.setItem(
        accountKey(),
        JSON.stringify({
          extraKeys: [
            'GUIDE',
            'GUIDE',
            'POWER',
            'NUM_1',
            7,
            null,
            ...Array.from({ length: 20 }, () => 'RED'),
            'BLUE',
          ],
        }),
      );
      expect(fresh().extraKeys()).toEqual(['GUIDE', 'RED', 'BLUE']);
    });

    it('fall back to automatic when the stored value is not a list', () => {
      localStorage.setItem(accountKey(), JSON.stringify({ extraKeys: 'GUIDE' }));
      expect(fresh().extraKeys()).toBeNull();
    });
  });

  describe('removed shortcut suggestions', () => {
    it('start empty, so an old saved choice without the field has nothing removed and is not customized', () => {
      localStorage.setItem(accountKey(), JSON.stringify({ name: '', buttonSize: 'comfortable' }));
      const prefs = fresh();
      expect(prefs.dismissedSuggestions()).toEqual([]);
      expect(prefs.customized()).toBe(false);
    });

    it('count as a customization and go back with "Restaurar padrão"', () => {
      const prefs = fresh();
      prefs.set({ dismissedSuggestions: ['max'] });
      expect(prefs.customized()).toBe(true);
      prefs.reset();
      expect(prefs.dismissedSuggestions()).toEqual([]);
      expect(prefs.customized()).toBe(false);
    });

    it('belong to the account that removed them, not to whoever signs in next on this device', () => {
      const prefs = fresh();
      prefs.set({ dismissedSuggestions: ['max'] });
      identify('other-user');
      expect(prefs.dismissedSuggestions()).toEqual([]);
      identify('tv-user');
      expect(prefs.dismissedSuggestions()).toEqual(['max']);
    });

    it('drop what is not a name, repeats and anything past the limit, instead of breaking the control', () => {
      localStorage.setItem(
        accountKey(),
        JSON.stringify({
          dismissedSuggestions: [
            'max',
            'max',
            '',
            7,
            null,
            ...Array.from({ length: 40 }, (_, i) => `k${i}`),
          ],
        }),
      );
      const kept = fresh().dismissedSuggestions();
      expect(kept[0]).toBe('max');
      expect(kept).toHaveLength(20);
      expect(new Set(kept).size).toBe(20);
      localStorage.setItem(accountKey(), JSON.stringify({ dismissedSuggestions: 'netflix' }));
      expect(fresh().dismissedSuggestions()).toEqual([]);
    });
  });

  describe('layout of the volume and channel pills', () => {
    it('is "sides" by default, as the control always was', () => {
      expect(fresh().pillLayout()).toBe('sides');
    });

    it('reads a choice saved before the field existed as "sides", keeping everything else', () => {
      // O formato de antes: sem o campo novo.
      localStorage.setItem(
        accountKey(),
        JSON.stringify({
          name: 'Sala',
          buttonSize: 'large',
          showMedia: false,
          showChannel: true,
          vibration: false,
          startPage: 'numbers',
          padSpeed: 'fast',
        }),
      );
      const prefs = fresh();
      expect(prefs.pillLayout()).toBe('sides');
      expect(prefs.title()).toBe('Sala');
      expect(prefs.buttonSize()).toBe('large');
      expect(prefs.showMedia()).toBe(false);
      expect(prefs.vibration()).toBe(false);
      expect(prefs.startPage()).toBe('numbers');
      expect(prefs.padSpeed()).toBe('fast');
      expect(prefs.customized()).toBe(true);
    });

    it('does not make an old, all-default choice look customized just because the field is missing', () => {
      localStorage.setItem(accountKey(), JSON.stringify({ name: '', buttonSize: 'comfortable' }));
      const prefs = fresh();
      expect(prefs.pillLayout()).toBe('sides');
      expect(prefs.customized()).toBe(false);
    });

    it('is "sides" for a stored value that is not one of the two', () => {
      for (const stored of ['top', 3, null, true]) {
        localStorage.setItem(accountKey(), JSON.stringify({ pillLayout: stored }));
        expect(fresh().pillLayout(), String(stored)).toBe('sides');
      }
    });

    it('keeps "row" for the next visit, under the same key as the other choices', () => {
      const prefs = fresh();
      prefs.set({ pillLayout: 'row' });
      expect(prefs.pillLayout()).toBe('row');
      expect(saved().pillLayout).toBe('row');
      expect(TV_PREFS_KEY).toBe('uniover.tv.prefs.v2');
      expect(accountKey()).toBe('uniover.tv.prefs.v2.tv-user');
      expect(fresh().pillLayout()).toBe('row');
    });

    it('counts as customized, and "reset" brings it back to "sides"', () => {
      const prefs = fresh();
      prefs.set({ pillLayout: 'row' });
      expect(prefs.customized()).toBe(true);
      prefs.reset();
      expect(prefs.pillLayout()).toBe('sides');
      expect(prefs.customized()).toBe(false);
      expect(fresh().pillLayout()).toBe('sides');
    });

    it('does not disturb the other choices when it changes', () => {
      const prefs = fresh();
      prefs.set({ buttonSize: 'compact', showChannel: false });
      prefs.set({ pillLayout: 'row' });
      expect(prefs.buttonSize()).toBe('compact');
      expect(prefs.showChannel()).toBe(false);
    });
  });

  it('changes one choice without touching the others', () => {
    const prefs = fresh();
    prefs.set({ name: 'Quarto' });
    prefs.set({ padSpeed: 'slow' });
    expect(prefs.name()).toBe('Quarto');
    expect(prefs.padSpeed()).toBe('slow');
    expect(prefs.buttonSize()).toBe('comfortable');
  });

  it('trims the nickname for display, limits it to 20 characters and falls back to "TV" when empty', () => {
    const prefs = fresh();
    prefs.set({ name: '   Sala de estar   ' });
    expect(prefs.name()).toBe('Sala de estar');
    expect(prefs.title()).toBe('Sala de estar');

    prefs.set({ name: 'x'.repeat(TV_NAME_MAX + 10) });
    expect(prefs.name()).toHaveLength(TV_NAME_MAX);

    prefs.set({ name: '    ' });
    expect(prefs.name()).toBe('');
    expect(prefs.title()).toBe('TV');
  });

  it('does not eat the space typed in the middle of a name', () => {
    const prefs = fresh();
    // Digitar "TV da sala" passa por "TV " (com o espaço no fim): o que foi digitado fica como está.
    prefs.set({ name: 'TV ' });
    expect(saved().name).toBe('TV ');
    expect(prefs.name()).toBe('TV');
    prefs.set({ name: 'TV d' });
    expect(prefs.name()).toBe('TV d');
  });

  it('puts everything back to the default with reset, and forgets the saved choices', () => {
    const prefs = fresh();
    prefs.set({ name: 'Sala', buttonSize: 'compact', showMedia: false, vibration: false });
    prefs.reset();
    expect(prefs.title()).toBe('TV');
    expect(prefs.buttonSize()).toBe('comfortable');
    expect(prefs.showMedia()).toBe(true);
    expect(prefs.vibration()).toBe(true);
    expect(prefs.customized()).toBe(false);
    expect(fresh().title()).toBe('TV');
  });

  it('switches the vibration choice synchronously with the active account', () => {
    const prefs = fresh();
    expect(prefs.vibration()).toBe(true);
    prefs.set({ name: 'Sala do dono', vibration: false });
    expect(prefs.vibration()).toBe(false);

    identify('guest-1');
    expect(prefs.vibration()).toBe(true);
    prefs.set({ name: 'TV da convidada', vibration: true });
    identify();
    expect(prefs.vibration()).toBe(false);
    identify('guest-1');
    expect(prefs.vibration()).toBe(true);
  });

  it('ignores what is stored when it is not valid, field by field', () => {
    localStorage.setItem(
      accountKey(),
      JSON.stringify({
        name: 42,
        buttonSize: 'gigantic',
        showMedia: 'yes',
        showChannel: false,
        vibration: false,
        startPage: 'touchpad',
        padSpeed: null,
      }),
    );
    const prefs = fresh();
    expect(prefs.name()).toBe('');
    expect(prefs.buttonSize()).toBe('comfortable');
    expect(prefs.showMedia()).toBe(true);
    // O que está certo é aproveitado.
    expect(prefs.showChannel()).toBe(false);
    expect(prefs.vibration()).toBe(false);
    expect(prefs.startPage()).toBe('touchpad');
    expect(prefs.padSpeed()).toBe('normal');
  });

  it.each(['not json', '[1,2]', 'null', '"text"'])('survives a stored value like %s', (stored) => {
    localStorage.setItem(accountKey(), stored);
    const prefs = fresh();
    expect(prefs.title()).toBe('TV');
    expect(prefs.buttonSize()).toBe('comfortable');
  });

  it('works with the storage blocked: reading and writing never throw and the choice lasts until reload', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const prefs = fresh();
    expect(prefs.title()).toBe('TV');
    expect(() => prefs.set({ name: 'Sala', buttonSize: 'large' })).not.toThrow();
    expect(prefs.title()).toBe('Sala');
    expect(prefs.buttonSize()).toBe('large');
    expect(() => prefs.reset()).not.toThrow();
  });

  it('works when the browser exposes no storage at all', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    const prefs = fresh();
    expect(prefs.title()).toBe('TV');
    expect(() => prefs.set({ name: 'Sala' })).not.toThrow();
    expect(prefs.title()).toBe('Sala');
    spy.mockRestore();
  });

  it('keeps preferences separate when the authenticated account changes', () => {
    const prefs = fresh();
    prefs.set({ name: 'Sala do dono' });

    identify('guest-1');
    expect(prefs.title()).toBe('TV');
    prefs.set({ name: 'Quarto da convidada' });

    identify();
    expect(prefs.title()).toBe('Sala do dono');
    expect(JSON.parse(localStorage.getItem(tvPrefsStorageKey('guest-1')) ?? 'null').name).toBe(
      'Quarto da convidada',
    );
  });

  it('keeps the old unscoped preference inert instead of assigning it to whichever account signs in first', () => {
    localStorage.setItem(
      'uniover.tv.prefs.v1',
      JSON.stringify({ name: 'Preferência de outra conta' }),
    );
    const prefs = fresh();
    expect(prefs.title()).toBe('TV');

    const token = `x.${btoa(JSON.stringify({ sub: 'tv-user' }))}.x`;
    TestBed.inject(SessionState).setToken(token, 600);
    expect(prefs.title()).toBe('TV');
    expect(localStorage.getItem('uniover.tv.prefs.v1')).toBe(
      JSON.stringify({ name: 'Preferência de outra conta' }),
    );
    expect(localStorage.getItem(accountKey())).toBeNull();
  });

  it('keeps legacy preferences available for a future explicit migration decision', () => {
    localStorage.setItem('uniover.tv.prefs.v1', JSON.stringify({ name: 'Old choice' }));
    fresh();
    expect(localStorage.getItem('uniover.tv.prefs.v1')).not.toBeNull();
  });
});

describe('TvPrefs per TV', () => {
  const account = 'conta-tv';
  const tv = (id: string, isDefault: boolean, name = `TV ${id}`) => ({
    id,
    name,
    isDefault,
    agentSlug: null,
    kind: 'android' as const,
    online: true,
    capabilities: [],
  });
  const setup = (seed?: () => void) => {
    TestBed.resetTestingModule();
    localStorage.clear();
    seed?.();
    TestBed.inject(SessionState).setUser({ id: account, email: 'a@b.c', displayName: 'A' });
    return { prefs: TestBed.inject(TvPrefs), selection: TestBed.inject(TvSelection) };
  };

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('keeps the default TV on the key it always had, so nothing already saved is lost', () => {
    const old = JSON.stringify({
      name: 'Sala',
      buttonSize: 'large',
      dismissedSuggestions: ['netflix'],
    });
    const { prefs, selection } = setup(() => localStorage.setItem(tvPrefsStorageKey(account), old));
    selection.setTvs([tv('casa', true), tv('amigo', false)]);
    expect(prefs.name()).toBe('Sala');
    expect(prefs.buttonSize()).toBe('large');
    expect(prefs.dismissedSuggestions()).toEqual(['netflix']);
    // O dono grava na base da TV (cópia local por id); a chave antiga fica como estava, só serve de semente.
    prefs.set({ showMedia: false });
    expect(JSON.parse(localStorage.getItem(tvLayoutCacheKey('casa')) ?? 'null').showMedia).toBe(
      false,
    );
    expect(localStorage.getItem(tvPrefsStorageKey(account))).toBe(old);
  });

  it('gives every other TV its own choices, and the suggestions removed there stay there', () => {
    const { prefs, selection } = setup();
    selection.setTvs([tv('casa', true), tv('amigo', false)]);
    prefs.set({ name: 'Sala', dismissedSuggestions: ['netflix'] });

    selection.select('amigo');
    expect(prefs.name()).toBe('');
    expect(prefs.dismissedSuggestions()).toEqual([]);
    prefs.set({ name: 'Quarto', buttonSize: 'compact' });

    selection.select('casa');
    expect(prefs.name()).toBe('Sala');
    expect(prefs.buttonSize()).toBe('comfortable');
    expect(prefs.dismissedSuggestions()).toEqual(['netflix']);

    expect(JSON.parse(localStorage.getItem(tvLayoutCacheKey('amigo')) ?? 'null').name).toBe(
      'Quarto',
    );
    expect(JSON.parse(localStorage.getItem(tvLayoutCacheKey('casa')) ?? 'null').name).toBe('Sala');
    expect(tvPrefsStorageKey(account, 'amigo')).not.toBe(tvPrefsStorageKey(account));
  });

  it('shows the name the administrator gave to the TV when there are several and no nickname', () => {
    const { prefs, selection } = setup();
    selection.setTvs([tv('casa', true, 'Casa'), tv('amigo', false, 'Raphael')]);
    expect(prefs.title()).toBe('Casa');
    selection.select('amigo');
    expect(prefs.title()).toBe('Raphael');
    prefs.set({ name: 'Quarto' });
    expect(prefs.title()).toBe('Quarto');
  });

  it('keeps the title of always with a single TV, whatever the administrator called it', () => {
    const { prefs, selection } = setup();
    selection.setTvs([tv('casa', true, 'Casa')]);
    expect(prefs.title()).toBe('TV');
  });

  it('finds the saved TV choices before the list arrives', () => {
    const first = setup();
    first.selection.setTvs([tv('casa', true), tv('amigo', false)]);
    first.selection.select('amigo');
    first.prefs.set({ name: 'Quarto' });

    const next = setup(() => {
      localStorage.setItem(tvPrefsStorageKey(account, 'amigo'), JSON.stringify({ name: 'Quarto' }));
      localStorage.setItem(
        tvSelectedStorageKey(account),
        JSON.stringify({ id: 'amigo', isDefault: false }),
      );
    });
    expect(next.prefs.name()).toBe('Quarto');
  });
});
