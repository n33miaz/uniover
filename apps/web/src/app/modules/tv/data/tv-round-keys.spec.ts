import { TestBed } from '@angular/core/testing';
import { makeTv } from '../tv-test-kit';
import { MAIN_EXTRAS_MAX } from './tv-extras';
import { TvPrefs } from './tv-prefs';
import { TvRoundKeys } from './tv-round-keys';
import { TvSelection } from './tv-selection';

const ALL = ['INPUT', 'GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE'].map((key) => `tv.key.${key}`);

describe('TvRoundKeys', () => {
  const keys = () => TestBed.inject(TvRoundKeys);
  const prefs = () => TestBed.inject(TvPrefs);
  const useTv = (kind: 'android' | 'samsung', declared: readonly string[] = ALL) => {
    TestBed.inject(TvSelection).setTvs([
      makeTv('tv', {
        isDefault: true,
        kind,
        capabilities: ['tv.remote', `tv.kind.${kind}`, 'tv.key.v3', ...declared],
      }),
    ]);
  };
  const names = (list: readonly { key: string }[]) => list.map((extra) => extra.key);

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    prefs().reset();
    localStorage.clear();
  });

  it('counts the fixed buttons: three, plus the Keyboard when the TV types, plus the four media keys', () => {
    useTv('android');
    expect(keys().base()).toBe(8);
    prefs().set({ showMedia: false });
    expect(keys().base()).toBe(4);
    useTv('samsung');
    expect(keys().base()).toBe(3);
    prefs().set({ showMedia: true });
    expect(keys().base()).toBe(7);
  });

  it('fills the single missing cell of a Samsung and leaves a full Android grid alone', () => {
    useTv('samsung');
    expect(names(keys().shown())).toEqual(['INPUT']);
    useTv('android');
    expect(keys().shown()).toEqual([]);
  });

  it('sends what is not on the main screen to "Mais botões"', () => {
    useTv('samsung');
    expect(names(keys().more())).toEqual(['GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE']);
    useTv('android');
    expect(names(keys().more())).toEqual(['INPUT', 'GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE']);
  });

  it('chooses an extra and lets the grid complete itself around it', () => {
    useTv('samsung');
    keys().toggle('BLUE');
    // Sete fixos mais um escolhido já fecham a fileira: o preenchimento automático (a Fonte) sai do lugar dele.
    expect(names(keys().shown())).toEqual(['BLUE']);
    expect(keys().chosen()).toEqual(['BLUE']);
    keys().toggle('RED');
    expect(names(keys().shown())).toEqual(['BLUE', 'RED', 'INPUT', 'GUIDE', 'INFO']);
    expect((keys().base() + keys().shown().length) % keys().columns()).toBe(0);
  });

  it('takes a choice back, and goes back to automatic when none is left', () => {
    useTv('samsung');
    keys().toggle('BLUE');
    keys().toggle('BLUE');
    expect(keys().chosen()).toEqual([]);
    expect(prefs().extraKeys()).toBeNull();
    expect(names(keys().shown())).toEqual(['INPUT']);
  });

  it('refuses a choice the grid could not complete, and one past the main screen limit', () => {
    useTv(
      'samsung',
      ['INPUT', 'GUIDE', 'INFO', 'RED'].map((key) => `tv.key.${key}`),
    );
    // Só quatro teclas: duas escolhas (nove) pediriam mais três, e a TV tem duas.
    keys().toggle('RED');
    expect(keys().canToggle('GUIDE')).toBe(false);
    expect(keys().canToggle('RED')).toBe(true);

    useTv(
      'android',
      ['INPUT', 'GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE', 'GREEN', 'YELLOW', 'EXIT', 'STOP'].map(
        (key) => `tv.key.${key}`,
      ),
    );
    prefs().set({
      extraKeys: ['INPUT', 'GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE', 'GREEN', 'YELLOW'],
    });
    expect(keys().shown()).toHaveLength(MAIN_EXTRAS_MAX);
    expect(keys().canToggle('EXIT')).toBe(false);
    expect(keys().canToggle('GUIDE')).toBe(true);
  });

  it('follows the options that change the columns', () => {
    useTv('android');
    expect(keys().columns()).toBe(4);
    prefs().set({ buttonSize: 'large' });
    expect(keys().columns()).toBe(3);
    prefs().set({ pillLayout: 'row' });
    expect(keys().columns()).toBe(4);
    prefs().set({ showMedia: false });
    expect(keys().columns()).toBe(4);
  });

  it('never leaves an empty cell, whatever the agent declares and the person picks', () => {
    for (const kind of ['android', 'samsung'] as const) {
      for (const declared of [[], ALL]) {
        for (const buttonSize of ['compact', 'comfortable', 'large'] as const) {
          for (const pillLayout of ['sides', 'row'] as const) {
            for (const showMedia of [true, false]) {
              useTv(kind, declared);
              prefs().set({ buttonSize, pillLayout, showMedia });
              const total = keys().base() + keys().shown().length;
              const label = JSON.stringify({
                kind,
                declared: declared.length,
                buttonSize,
                pillLayout,
                showMedia,
              });
              expect(total % keys().gridColumns(), label).toBe(0);
            }
          }
        }
      }
    }
  });

  it('keeps a Samsung from an old agent complete in the large size (only the Input is known)', () => {
    useTv('samsung', []);
    prefs().set({ buttonSize: 'large' });
    expect(names(keys().shown())).toEqual(['INPUT']);
    expect(keys().gridColumns()).toBe(2);
  });
});
