import { makeShortcut } from '../tv-test-kit';
import {
  SUGGESTION_GAP_PX,
  SUGGESTION_SLACK_PX,
  SUGGESTION_TILE_PX,
  TV_SUGGESTED_APPS,
  matchSuggestion,
  pickSuggestions,
  suggestionCapacity,
} from './tv-suggestions';

const app = (key: string) => TV_SUGGESTED_APPS.find((item) => item.key === key)!;

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

describe('pickSuggestions', () => {
  it('offers the catalog in order, up to the capacity', () => {
    expect(pickSuggestions([], 3).map((item) => item.key)).toEqual([
      'youtube',
      'netflix',
      'prime-video',
    ]);
    expect(pickSuggestions([], 0)).toEqual([]);
    expect(pickSuggestions([], 99)).toHaveLength(TV_SUGGESTED_APPS.length);
  });

  it('skips the removed ones and fills the space with the next ones', () => {
    expect(pickSuggestions(['netflix'], 3).map((item) => item.key)).toEqual([
      'youtube',
      'prime-video',
      'max',
    ]);
  });
});

describe('matchSuggestion', () => {
  it('finds nothing without a list or without the app on it', () => {
    expect(matchSuggestion(app('youtube'), null)).toBeNull();
    expect(matchSuggestion(app('youtube'), [makeShortcut(1)])).toBeNull();
  });

  it('matches by the known package', () => {
    const shortcut = makeShortcut(2, { package: 'com.netflix.ninja' });
    expect(matchSuggestion(app('netflix'), [makeShortcut(1), shortcut])).toBe(shortcut);
  });

  it('matches by the name the TV publishes, ignoring accents, case and punctuation', () => {
    const shortcut = makeShortcut(1, { tvLabel: 'DISNEY PLUS', enabled: false });
    expect(matchSuggestion(app('disney-plus'), [shortcut])).toBe(shortcut);
    const owned = makeShortcut(1, { customLabel: 'Prime  Vídeo', tvLabel: null });
    expect(matchSuggestion(app('prime-video'), [owned])).toBe(owned);
  });

  it('does not take a similar name for the same app', () => {
    const kids = makeShortcut(1, {
      tvLabel: 'YouTube Kids',
      package: 'com.google.android.youtube.tvkids',
    });
    expect(matchSuggestion(app('youtube'), [kids])).toBeNull();
  });

  it('ignores an app that left the TV', () => {
    const gone = makeShortcut(1, { package: 'com.netflix.ninja', installed: false });
    expect(matchSuggestion(app('netflix'), [gone])).toBeNull();
  });
});
