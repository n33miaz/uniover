import { pngIcon, webpIcon } from '../tv-test-kit';
import {
  FALLBACK_HUES,
  fallbackGlyph,
  fallbackHue,
  iconSource,
  samsungIconSource,
} from './app-icon-source';

describe('iconSource', () => {
  it('accepts a PNG or a WebP as a data URI', () => {
    expect(iconSource(pngIcon(48, 48))).toBe(pngIcon(48, 48));
    expect(iconSource(webpIcon('lossy', 48, 48))).toBe(webpIcon('lossy', 48, 48));
  });

  it('turns everything else into "no icon": missing, empty, other types and network addresses', () => {
    for (const value of [
      undefined,
      null,
      '',
      42,
      {},
      'data:image/png;base64,',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PGI+',
      'data:image/png;charset=utf-8,abc',
      'https://exemplo.test/icone.png',
      'javascript:alert(1)',
    ]) {
      expect(iconSource(value), String(value)).toBeNull();
    }
  });
});

describe('samsungIconSource', () => {
  it('uses a local branded asset for known Tizen aliases only', () => {
    expect(samsungIconSource('samsung.app.id3201907018807')).toBe('/tv/app-icons/netflix.png');
    expect(samsungIconSource('com.samsung.tv.tvPlusDeeplinker')).toBe(
      '/tv/app-icons/samsung-tv-plus.svg',
    );
    expect(samsungIconSource('samsung.app.iddesconhecido')).toBeNull();
  });
});

describe('fallbackHue', () => {
  it('is stable for a package and always one of the available colors', () => {
    expect(fallbackHue('com.spotify.tv.android')).toBe(fallbackHue('com.spotify.tv.android'));
    for (const name of ['', 'a', 'com.android.vending', 'com.google.android.youtube.tv']) {
      const hue = fallbackHue(name);
      expect(Number.isInteger(hue) && hue >= 0 && hue < FALLBACK_HUES, name).toBe(true);
    }
  });

  it('spreads different packages over several colors', () => {
    const hues = new Set(
      Array.from({ length: 40 }, (_, index) => fallbackHue(`exemplo.pacote.app${index}`)),
    );
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });
});

describe('fallbackGlyph', () => {
  const base = { customLabel: null, tvLabel: null, position: 3 };

  it('is the capital initial of the owner name, then of the name the agent publishes', () => {
    expect(fallbackGlyph({ ...base, customLabel: 'sala' })).toBe('S');
    expect(fallbackGlyph({ ...base, tvLabel: 'Spotify' })).toBe('S');
    expect(fallbackGlyph({ ...base, customLabel: 'Jogos', tvLabel: 'Spotify' })).toBe('J');
    expect(fallbackGlyph({ ...base, customLabel: '   ', tvLabel: 'YouTube' })).toBe('Y');
  });

  it('keeps accents and numbers, and skips leading symbols and emoji', () => {
    expect(fallbackGlyph({ ...base, customLabel: 'épico' })).toBe('É');
    expect(fallbackGlyph({ ...base, tvLabel: '4K Plus' })).toBe('4');
    expect(fallbackGlyph({ ...base, customLabel: '📺 Sala' })).toBe('S');
    expect(fallbackGlyph({ ...base, customLabel: '- Cinema' })).toBe('C');
  });

  it('is the position number, never a meaningless letter, when there is no name or no letter in it', () => {
    expect(fallbackGlyph(base)).toBe('3');
    expect(fallbackGlyph({ ...base, customLabel: '  ', tvLabel: '' })).toBe('3');
    expect(fallbackGlyph({ ...base, customLabel: '★★★' })).toBe('3');
    expect(fallbackGlyph({ ...base, position: 12 })).toBe('12');
  });
});
