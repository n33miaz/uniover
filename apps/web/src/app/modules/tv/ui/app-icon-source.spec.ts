import { pngIcon, webpIcon } from '../tv-test-kit';
import {
  FALLBACK_HUES,
  fallbackGlyph,
  fallbackHue,
  iconShape,
  iconSource,
  imageSize,
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

describe('imageSize', () => {
  it('reads a PNG from its header', () => {
    expect(imageSize(pngIcon(96, 96))).toEqual({ width: 96, height: 96 });
    expect(imageSize(pngIcon(320, 180))).toEqual({ width: 320, height: 180 });
  });

  it('reads the three kinds of WebP from their headers', () => {
    expect(imageSize(webpIcon('lossy', 320, 180))).toEqual({ width: 320, height: 180 });
    expect(imageSize(webpIcon('lossless', 320, 180))).toEqual({ width: 320, height: 180 });
    expect(imageSize(webpIcon('extended', 320, 180))).toEqual({ width: 320, height: 180 });
    expect(imageSize(webpIcon('lossless', 64, 64))).toEqual({ width: 64, height: 64 });
  });

  it('gives up (null) on what it cannot read: other bytes, a cut header, a size of zero, broken base64', () => {
    expect(imageSize('data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    expect(imageSize('data:image/png;base64,iVBORw0K')).toBeNull();
    expect(imageSize(pngIcon(0, 0))).toBeNull();
    expect(imageSize('data:image/png;base64,@@@@')).toBeNull();
    expect(imageSize('data:image/webp;base64,UklGRg==')).toBeNull();
  });
});

describe('iconShape', () => {
  it('treats a 16:9 banner as wide and squares, near-squares and portraits as square', () => {
    expect(iconShape(pngIcon(320, 180))).toBe('wide');
    expect(iconShape(webpIcon('extended', 640, 360))).toBe('wide');
    expect(iconShape(pngIcon(160, 100))).toBe('wide');
    expect(iconShape(pngIcon(96, 96))).toBe('square');
    expect(iconShape(pngIcon(128, 100))).toBe('square');
    expect(iconShape(pngIcon(90, 120))).toBe('square');
  });

  it('is square when the header cannot be read (the image still shows whole, never cropped)', () => {
    expect(iconShape('data:image/png;base64,AAAA')).toBe('square');
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
