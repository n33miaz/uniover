import { makeTv } from '../../tv-test-kit';
import {
  DEFAULT_LIVRE_CONFIG,
  TV_LIVRE_CAPABILITY,
  normalizeColor,
  parseLivreConfig,
  parseLivreView,
  tvHasLivre,
} from './livre-types';

describe('normalizeColor', () => {
  it('accepts #rrggbb in any case and returns it in lower case', () => {
    expect(normalizeColor('#1B2440')).toBe('#1b2440');
    expect(normalizeColor('#aabbcc')).toBe('#aabbcc');
  });

  it.each(['1b2440', '#fff', '#12345g', '', null, 12])('rejects %j', (value) => {
    expect(normalizeColor(value)).toBeNull();
  });
});

describe('parseLivreConfig', () => {
  it('gives the approved default home for anything that is not a config', () => {
    expect(parseLivreConfig(null)).toEqual(DEFAULT_LIVRE_CONFIG);
    expect(parseLivreConfig('x').apps.mode).toBe('all');
  });

  it('reads the fields it knows and falls back field by field on the ones that come wrong', () => {
    const config = parseLivreConfig({
      clock: { size: 'medium', format: 'nope', seconds: true },
      wallpaper: { type: 'photo', colors: ['#AA0000', 'red', '#00bb00'], angle: 90, dim: 5 },
      apps: { mode: 'listed', items: ['a.b', 3, ''], hidden: ['c.d'], showFactory: true },
      icons: { size: 'large', labels: 'never' },
      builtin: { settings: false },
      sleep: { maxMinutes: 9999 },
    });
    expect(config.clock).toEqual({
      enabled: true,
      size: 'medium',
      format: '24h',
      seconds: true,
      date: true,
    });
    expect(config.wallpaper).toEqual({
      type: 'photo',
      colors: ['#aa0000', '#00bb00'],
      angle: 90,
      dim: 0.8,
    });
    expect(config.apps).toEqual({
      mode: 'listed',
      items: ['a.b'],
      hidden: ['c.d'],
      showFactory: true,
    });
    expect(config.icons).toEqual({ size: 'large', labels: 'never' });
    expect(config.builtin).toEqual({ settings: false, sleep: false });
    expect(config.sleep.maxMinutes).toBe(720);
  });
});

describe('parseLivreView', () => {
  const full = {
    available: true,
    supported: true,
    installed: true,
    version: '1.2.0',
    isHome: false,
    factoryLauncher: 'com.exemplo.fabrica',
    disabledPackages: ['com.exemplo.off'],
    apps: [
      { package: 'a.b', factory: false, disabled: false },
      { package: 'a.b', factory: true, disabled: true },
      { package: 'c.d', factory: true, disabled: false },
      { package: '', factory: false, disabled: false },
      'lixo',
    ],
    stateAt: '2026-10-31T12:00:00Z',
    config: { clock: { size: 'small' } },
    hasPhoto: true,
    revision: 7,
  };

  it('reads the whole view, dropping apps without a package and repeated ones', () => {
    const view = parseLivreView(full)!;
    expect(view.available).toBe(true);
    expect(view.supported).toBe(true);
    expect(view.version).toBe('1.2.0');
    expect(view.factoryLauncher).toBe('com.exemplo.fabrica');
    expect(view.apps).toEqual([
      { package: 'a.b', factory: false, disabled: false },
      { package: 'c.d', factory: true, disabled: false },
    ]);
    expect(view.config.clock.size).toBe('small');
    expect(view.hasPhoto).toBe(true);
    expect(view.revision).toBe(7);
  });

  it('keeps "never received a state" apart from "not supported"', () => {
    const view = parseLivreView({ available: false, supported: null, config: {} })!;
    expect(view.supported).toBeNull();
    expect(view.installed).toBe(false);
    expect(view.revision).toBe(0);
    expect(view.apps).toEqual([]);
    expect(parseLivreView({ available: true, supported: false })!.supported).toBe(false);
  });

  it('refuses a body that is not a view', () => {
    expect(parseLivreView(null)).toBeNull();
    expect(parseLivreView({ installed: true })).toBeNull();
    expect(parseLivreView('x')).toBeNull();
  });
});

describe('tvHasLivre', () => {
  it('is true only when the TV declares the capability: no information means no', () => {
    expect(tvHasLivre(null)).toBe(false);
    expect(tvHasLivre(makeTv('a', { capabilities: [] }))).toBe(false);
    expect(tvHasLivre(makeTv('a', { capabilities: ['tv.adb'] }))).toBe(false);
    expect(tvHasLivre(makeTv('a', { capabilities: ['tv.adb', TV_LIVRE_CAPABILITY] }))).toBe(true);
  });
});
