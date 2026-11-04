import { makeShortcut } from '../../tv-test-kit';
import {
  GRADIENT_PRESETS,
  appRows,
  buildConfig,
  gradientCss,
  groupApps,
  moveApp,
  normalizeApps,
  packageLabel,
  presetFor,
  previewApps,
  previewClock,
  sameConfig,
  setAppChosen,
} from './livre-config';
import { DEFAULT_LIVRE_CONFIG, LivreApp, LivreConfig } from './livre-types';

const APPS: LivreApp[] = [
  { package: 'com.exemplo.zeta', factory: false, disabled: false },
  { package: 'com.exemplo.alfa', factory: false, disabled: false },
  { package: 'com.exemplo.fabrica', factory: true, disabled: false },
  { package: 'com.exemplo.fora', factory: false, disabled: true },
  { package: 'com.exemplo.sistema', factory: true, disabled: false },
];

function withItems(items: string[], extra: Partial<LivreConfig['apps']> = {}): LivreConfig {
  return { ...DEFAULT_LIVRE_CONFIG, apps: { ...DEFAULT_LIVRE_CONFIG.apps, items, ...extra } };
}

describe('packageLabel', () => {
  it('uses the most meaningful word of the package, capitalized', () => {
    expect(packageLabel('com.exemplo.cinema.tv')).toBe('Cinema');
    expect(packageLabel('org.videos')).toBe('Videos');
    expect(packageLabel('tv')).toBe('Tv');
  });
});

describe('appRows', () => {
  it('takes name and icon from the shortcut of the TV, and falls back to the package', () => {
    const icon = 'data:image/png;base64,AAAA';
    const rows = appRows(
      APPS,
      [
        makeShortcut(1, { package: 'com.exemplo.alfa', tvLabel: 'Alfa TV', iconDataUri: icon }),
        makeShortcut(2, { package: 'com.exemplo.zeta', customLabel: ' Meu Zeta ', tvLabel: 'Z' }),
      ],
      withItems(['com.exemplo.zeta']),
    );
    const alfa = rows.find((row) => row.package === 'com.exemplo.alfa')!;
    expect(alfa.label).toBe('Alfa TV');
    expect(alfa.subject.iconDataUri).toBe(icon);
    const zeta = rows.find((row) => row.package === 'com.exemplo.zeta')!;
    expect(zeta.label).toBe('Meu Zeta');
    expect(zeta.chosen).toBe(true);
    const bare = rows.find((row) => row.package === 'com.exemplo.fora')!;
    expect(bare.label).toBe('Fora');
    expect(bare.subject.iconDataUri).toBeNull();
    expect(bare.disabled).toBe(true);
  });
});

describe('groupApps', () => {
  it('lists the chosen ones in the order of the Home and splits the rest by name, factory apart', () => {
    const config = withItems(['com.exemplo.zeta', 'com.exemplo.sistema']);
    const rows = appRows(APPS, [], config);
    const groups = groupApps(rows, config);
    expect(groups.chosen.map((row) => row.package)).toEqual([
      'com.exemplo.zeta',
      'com.exemplo.sistema',
    ]);
    expect(groups.others.map((row) => row.package)).toEqual([
      'com.exemplo.alfa',
      'com.exemplo.fora',
    ]);
    expect(groups.factory.map((row) => row.package)).toEqual(['com.exemplo.fabrica']);
  });
});

describe('the choice of apps', () => {
  it('"all" with the factory hidden when nothing is chosen, "listed" in order when something is', () => {
    expect(normalizeApps(withItems([])).apps).toEqual({
      mode: 'all',
      items: [],
      hidden: [],
      showFactory: false,
    });
    const listed = normalizeApps(withItems(['a.b', 'c.d', 'a.b'], { showFactory: true }));
    expect(listed.apps.mode).toBe('listed');
    expect(listed.apps.items).toEqual(['a.b', 'c.d']);
    expect(listed.apps.showFactory).toBe(false);
  });

  it('adds a chosen app at the end, removes it again, and a chosen app stops being hidden', () => {
    let config = setAppChosen(withItems([], { hidden: ['a.b'] }), 'a.b', true);
    config = setAppChosen(config, 'c.d', true);
    expect(config.apps.items).toEqual(['a.b', 'c.d']);
    expect(config.apps.hidden).toEqual([]);
    expect(config.apps.mode).toBe('listed');
    config = setAppChosen(config, 'a.b', false);
    expect(config.apps.items).toEqual(['c.d']);
    config = setAppChosen(config, 'c.d', false);
    expect(config.apps.mode).toBe('all');
    expect(setAppChosen(config, 'x.y', false)).toBe(config);
  });

  it('moves an app up or down and stays put at the ends', () => {
    const config = withItems(['a.a', 'b.b', 'c.c']);
    expect(moveApp(config, 'b.b', -1).apps.items).toEqual(['b.b', 'a.a', 'c.c']);
    expect(moveApp(config, 'b.b', 1).apps.items).toEqual(['a.a', 'c.c', 'b.b']);
    expect(moveApp(config, 'a.a', -1)).toBe(config);
    expect(moveApp(config, 'c.c', 1)).toBe(config);
    expect(moveApp(config, 'x.x', 1)).toBe(config);
  });
});

describe('previewApps', () => {
  const rows = appRows(APPS, [], DEFAULT_LIVRE_CONFIG);

  it('with nothing chosen shows every app that is not factory, not disabled, by name', () => {
    expect(previewApps(DEFAULT_LIVRE_CONFIG, rows).map((row) => row.package)).toEqual([
      'com.exemplo.alfa',
      'com.exemplo.zeta',
    ]);
  });

  it('with some chosen shows only them, in order, even a factory app (disabled ones never)', () => {
    const config = normalizeApps(
      withItems(['com.exemplo.sistema', 'com.exemplo.zeta', 'com.exemplo.fora']),
    );
    expect(previewApps(config, rows).map((row) => row.package)).toEqual([
      'com.exemplo.sistema',
      'com.exemplo.zeta',
    ]);
  });

  it('follows the contract in "all": the cited apps first, then the rest, minus the hidden', () => {
    const config = withItems(['com.exemplo.zeta'], { mode: 'all', hidden: ['com.exemplo.alfa'] });
    expect(previewApps(config, rows).map((row) => row.package)).toEqual(['com.exemplo.zeta']);
    const showing = withItems(['com.exemplo.zeta'], { mode: 'all', showFactory: true });
    expect(previewApps(showing, rows).map((row) => row.package)).toEqual([
      'com.exemplo.zeta',
      'com.exemplo.alfa',
      'com.exemplo.fabrica',
      'com.exemplo.sistema',
    ]);
  });
});

describe('buildConfig', () => {
  const context = { hasPhoto: true, apps: APPS };

  it('drops apps that are no longer on the TV and keeps the order of the others', () => {
    const config = buildConfig(
      withItems(['com.exemplo.zeta', 'com.sumiu', 'com.exemplo.alfa']),
      context,
    );
    expect(config.apps).toEqual({
      mode: 'listed',
      items: ['com.exemplo.zeta', 'com.exemplo.alfa'],
      hidden: [],
      showFactory: false,
    });
  });

  it('keeps the chosen apps when the agent has not reported the installed ones yet', () => {
    const config = buildConfig(withItems(['com.qualquer']), { hasPhoto: false, apps: [] });
    expect(config.apps.items).toEqual(['com.qualquer']);
  });

  it('chosen apps off means mode all with the factory hidden', () => {
    const config = buildConfig(withItems(['com.sumiu']), context);
    expect(config.apps).toEqual({ mode: 'all', items: [], hidden: [], showFactory: false });
  });

  it('only keeps the photo as background when there is a photo', () => {
    const photo: LivreConfig = {
      ...DEFAULT_LIVRE_CONFIG,
      wallpaper: { ...DEFAULT_LIVRE_CONFIG.wallpaper, type: 'photo' },
    };
    expect(buildConfig(photo, context).wallpaper.type).toBe('photo');
    expect(buildConfig(photo, { hasPhoto: false, apps: APPS }).wallpaper.type).toBe('gradient');
  });

  it('fixes colors, dim and sleep time that the API would refuse', () => {
    const config = buildConfig(
      {
        ...DEFAULT_LIVRE_CONFIG,
        wallpaper: { ...DEFAULT_LIVRE_CONFIG.wallpaper, colors: ['#ABCDEF', 'azul'], dim: 3 },
        sleep: { maxMinutes: 5000.4 },
      },
      context,
    );
    expect(config.wallpaper.colors).toEqual(['#abcdef', '#abcdef']);
    expect(config.wallpaper.dim).toBe(0.8);
    expect(config.sleep.maxMinutes).toBe(720);
    const none = buildConfig(
      { ...DEFAULT_LIVRE_CONFIG, wallpaper: { ...DEFAULT_LIVRE_CONFIG.wallpaper, colors: [] } },
      context,
    );
    expect(none.wallpaper.colors).toEqual(DEFAULT_LIVRE_CONFIG.wallpaper.colors);
  });

  it('does not touch what the screens do not edit', () => {
    const custom: LivreConfig = {
      ...DEFAULT_LIVRE_CONFIG,
      clock: { ...DEFAULT_LIVRE_CONFIG.clock, size: 'small', seconds: true },
      icons: { size: 'large', labels: 'focus' },
      builtin: { settings: true, sleep: true },
    };
    const built = buildConfig(custom, context);
    expect(built.clock).toEqual(custom.clock);
    expect(built.icons).toEqual(custom.icons);
    expect(built.builtin).toEqual(custom.builtin);
  });
});

describe('sameConfig', () => {
  it('is true for equal configs and false when the order of the apps changes', () => {
    expect(sameConfig(withItems(['a.a', 'b.b']), withItems(['a.a', 'b.b']))).toBe(true);
    expect(sameConfig(withItems(['a.a', 'b.b']), withItems(['b.b', 'a.a']))).toBe(false);
  });
});

describe('gradientCss', () => {
  it('turns the Android angles into corner to corner CSS directions', () => {
    expect(gradientCss(['#111111', '#222222'], 315)).toBe(
      'linear-gradient(to bottom right, #111111, #222222)',
    );
    expect(gradientCss(['#111111', '#222222'], 0)).toBe(
      'linear-gradient(to right, #111111, #222222)',
    );
    expect(gradientCss(['#111111', '#222222'], 90)).toBe(
      'linear-gradient(to top, #111111, #222222)',
    );
    expect(gradientCss(['#111111', '#222222'], 270)).toBe(
      'linear-gradient(to bottom, #111111, #222222)',
    );
  });

  it('falls back to 315 for an angle that is not valid and repeats a single color', () => {
    expect(gradientCss(['#111111', '#222222'], 77)).toContain('to bottom right');
    expect(gradientCss(['#111111'], 315)).toBe(
      'linear-gradient(to bottom right, #111111, #111111)',
    );
  });
});

describe('gradient presets', () => {
  it('keep white text readable (WCAG AA), are in #rrggbb, and are findable by their colors', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(4);
    const linear = (channel: number) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    for (const preset of GRADIENT_PRESETS) {
      for (const color of preset.colors) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
        const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(color.slice(i, i + 2), 16) / 255));
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        // Contraste do branco sobre a cor: (1 + 0,05) / (L + 0,05).
        expect(1.05 / (luminance + 0.05), `${preset.id} ${color}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(presetFor(preset.colors)?.id).toBe(preset.id);
    }
    expect(presetFor(['#010101', '#020202'])).toBeNull();
  });
});

describe('previewClock', () => {
  const now = new Date('2026-10-31T21:05:09');

  it('shows 24 hours by default, with the date, and the seconds when asked', () => {
    const clock = DEFAULT_LIVRE_CONFIG.clock;
    expect(previewClock(now, clock).time).toBe('21:05');
    expect(previewClock(now, clock).date).toBe('sábado, 31 de outubro');
    expect(previewClock(now, { ...clock, seconds: true }).time).toBe('21:05:09');
  });

  it('shows 12 hours when the config says so', () => {
    const time = previewClock(now, { ...DEFAULT_LIVRE_CONFIG.clock, format: '12h' }).time;
    expect(time).toMatch(/^09:05/);
    expect(time).toMatch(/PM/i);
  });
});
