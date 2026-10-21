import { TestBed } from '@angular/core/testing';
import { KEY_SCALE, TV_NAME_MAX, TV_PREFS_KEY, TvPrefs, vibrationEnabled } from './tv-prefs';

describe('TvPrefs', () => {
  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(TvPrefs);
  };
  const saved = () => JSON.parse(localStorage.getItem(TV_PREFS_KEY) ?? 'null');

  beforeEach(() => localStorage.clear());
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
    expect(localStorage.getItem(TV_PREFS_KEY)).toBeNull();
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
    expect(again.customized()).toBe(true);
  });

  describe('layout of the volume and channel pills', () => {
    it('is "sides" by default, as the control always was', () => {
      expect(fresh().pillLayout()).toBe('sides');
    });

    it('reads a choice saved before the field existed as "sides", keeping everything else', () => {
      // O formato de antes: sem o campo novo.
      localStorage.setItem(
        TV_PREFS_KEY,
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
      localStorage.setItem(TV_PREFS_KEY, JSON.stringify({ name: '', buttonSize: 'comfortable' }));
      const prefs = fresh();
      expect(prefs.pillLayout()).toBe('sides');
      expect(prefs.customized()).toBe(false);
    });

    it('is "sides" for a stored value that is not one of the two', () => {
      for (const stored of ['top', 3, null, true]) {
        localStorage.setItem(TV_PREFS_KEY, JSON.stringify({ pillLayout: stored }));
        expect(fresh().pillLayout(), String(stored)).toBe('sides');
      }
    });

    it('keeps "row" for the next visit, under the same key as the other choices', () => {
      const prefs = fresh();
      prefs.set({ pillLayout: 'row' });
      expect(prefs.pillLayout()).toBe('row');
      expect(saved().pillLayout).toBe('row');
      expect(TV_PREFS_KEY).toBe('uniover.tv.prefs.v1');
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

  it('mirrors the vibration choice for the code that has no injection', () => {
    const prefs = fresh();
    expect(vibrationEnabled()).toBe(true);
    prefs.set({ vibration: false });
    expect(vibrationEnabled()).toBe(false);
    // Uma visita nova já nasce com a escolha guardada.
    fresh();
    expect(vibrationEnabled()).toBe(false);
    TestBed.inject(TvPrefs).reset();
    expect(vibrationEnabled()).toBe(true);
  });

  it('ignores what is stored when it is not valid, field by field', () => {
    localStorage.setItem(
      TV_PREFS_KEY,
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
    localStorage.setItem(TV_PREFS_KEY, stored);
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
});
