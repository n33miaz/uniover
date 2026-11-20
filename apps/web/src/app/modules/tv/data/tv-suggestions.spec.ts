import { makeShortcut } from '../tv-test-kit';
import {
  SUGGESTION_GAP_PX,
  SUGGESTION_SLACK_PX,
  SUGGESTION_TILE_PX,
  TV_KNOWN_APPS,
  filterApps,
  knownApp,
  pickSuggestions,
  rankInstalledApps,
  replacementOrder,
  suggestionCapacity,
} from './tv-suggestions';

/** Uma TV com apps de verdade na ordem em que ela os listou (nenhum no controle). */
const tvList = () => [
  makeShortcut(1, { package: 'org.videolan.vlc', tvLabel: 'VLC', enabled: false }),
  makeShortcut(2, { package: 'com.exemplo.zebra', tvLabel: 'Zebra', enabled: false }),
  makeShortcut(3, { package: 'com.netflix.ninja', tvLabel: 'Netflix', enabled: false }),
  makeShortcut(4, { package: 'com.exemplo.agua', tvLabel: 'Água', enabled: false }),
  makeShortcut(5, { package: 'com.google.android.youtube.tv', tvLabel: 'YouTube', enabled: false }),
  makeShortcut(6, {
    package: 'com.globo.globotv',
    tvLabel: 'Globoplay',
    installed: false,
    enabled: false,
  }),
];
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe('suggestionCapacity', () => {
  it('shows nothing until the strip has a measured width', () => {
    expect(suggestionCapacity(0)).toBe(0);
    expect(suggestionCapacity(-10)).toBe(0);
    expect(suggestionCapacity(Number.NaN)).toBe(0);
  });

  it('fits only whole tiles and always leaves the slack free', () => {
    for (const width of [150, 328, 358, 380, 411, 600]) {
      const count = suggestionCapacity(width);
      const used = count * SUGGESTION_TILE_PX + Math.max(0, count - 1) * SUGGESTION_GAP_PX;
      expect(used + SUGGESTION_SLACK_PX, `largura ${width}`).toBeLessThanOrEqual(width);
      // Mais um azulejo já não caberia com a folga.
      const more = count + 1;
      const moreUsed = more * SUGGESTION_TILE_PX + (more - 1) * SUGGESTION_GAP_PX;
      expect(moreUsed + SUGGESTION_SLACK_PX, `largura ${width}`).toBeGreaterThan(width);
    }
  });

  it('gives the values measured on the two target phones', () => {
    // 390 de tela: a faixa tem 358; 360 de tela: 328.
    expect(suggestionCapacity(358)).toBe(5);
    expect(suggestionCapacity(328)).toBe(4);
  });
});

describe('rankInstalledApps', () => {
  it('puts the well-known brands first, in their order, then the rest by name, and leaves out what left the TV', () => {
    // YouTube, Netflix e VLC são conhecidas (nessa ordem); Água e Zebra vêm depois, em ordem alfabética sem acento.
    expect(ids(rankInstalledApps(tvList()))).toEqual(['s5', 's3', 's1', 's4', 's2']);
  });

  it('gives nothing without a list', () => {
    expect(rankInstalledApps(null)).toEqual([]);
  });

  it('knows the Samsung id of a brand as the same brand', () => {
    expect(knownApp('samsung.app.id3201907018807')?.key).toBe('netflix');
    expect(knownApp('com.exemplo.zebra')).toBeNull();
  });

  it('gives every brand a tint with an ink of at least 4.5:1', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const brand of TV_KNOWN_APPS) {
      const [a, b] = [luminance(brand.tint), luminance(brand.ink)].sort((x, y) => y - x);
      expect((a + 0.05) / (b + 0.05), brand.key).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('pickSuggestions', () => {
  it('offers only installed apps that are not in the control yet, brands first, up to the capacity', () => {
    expect(ids(pickSuggestions(tvList(), [], 3))).toEqual(['s5', 's3', 's1']);
    expect(pickSuggestions(tvList(), [], 0)).toEqual([]);
    expect(pickSuggestions(null, [], 5)).toEqual([]);
  });

  it('never suggests an app that is already in the control', () => {
    const list = tvList().map((item) => (item.id === 's5' ? { ...item, enabled: true } : item));
    expect(ids(pickSuggestions(list, [], 2))).toEqual(['s3', 's1']);
  });

  it('skips the removed ones (by package) and fills the space with the next ones', () => {
    expect(ids(pickSuggestions(tvList(), ['com.netflix.ninja'], 3))).toEqual(['s5', 's1', 's4']);
  });
});

describe('filterApps', () => {
  it('finds by name without accents or case, and by package', () => {
    const list = rankInstalledApps(tvList());
    expect(ids(filterApps(list, 'agua'))).toEqual(['s4']);
    expect(ids(filterApps(list, 'NETF'))).toEqual(['s3']);
    expect(ids(filterApps(list, 'videolan'))).toEqual(['s1']);
    expect(filterApps(list, '  ')).toHaveLength(list.length);
    expect(filterApps(list, 'nada disso')).toEqual([]);
  });
});

describe('replacementOrder', () => {
  it('puts the new app right where the old one was, and keeps everyone else in order', () => {
    const list = [makeShortcut(1), makeShortcut(2), makeShortcut(3), makeShortcut(4)];
    expect(replacementOrder(list, 's2', 's4')).toEqual(['s1', 's4', 's2', 's3']);
    expect(replacementOrder(list, 's3', 's1')).toEqual(['s2', 's1', 's3', 's4']);
  });

  it('gives nothing for the same app or an unknown one', () => {
    const list = [makeShortcut(1), makeShortcut(2)];
    expect(replacementOrder(list, 's1', 's1')).toBeNull();
    expect(replacementOrder(list, 's1', 's9')).toBeNull();
  });
});
