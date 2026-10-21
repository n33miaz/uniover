import {
  ANALYSIS_SIDE,
  MAX_TRIM,
  analyzeIconEdges,
  cachedIconFit,
  cropSquare,
  fitFromImage,
  iconFit,
  readIconPixels,
  rememberIconFit,
  resetIconFitCache,
} from './app-icon-fit';

type Rgba = readonly [number, number, number, number];

const CLEAR: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [18, 18, 18, 255];
const BLUE: Rgba = [30, 120, 200, 255];
const AMBER: Rgba = [224, 160, 48, 255];
const GREEN: Rgba = [30, 215, 96, 255];

/** Monta um RGBA `size` × `size` pixel a pixel; `paint` devolve a cor do pixel (x, y). */
function pixels(size: number, paint: (x: number, y: number) => Rgba, height = size) {
  const data = new Uint8ClampedArray(size * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) data.set(paint(x, y), (y * size + x) * 4);
  }
  return data;
}

const inside = (v: number, from: number, to: number) => v >= from && v < to;

/** Uma placa opaca que começa a `margin` pixels da borda, sobre `around`. */
const plateOn = (around: Rgba, plate: Rgba, margin: number, size = 64) =>
  pixels(size, (x, y) =>
    inside(x, margin, size - margin) && inside(y, margin, size - margin) ? plate : around,
  );

describe('analyzeIconEdges', () => {
  it('trims a transparent margin down to the plate and takes the plate color as the background', () => {
    const result = analyzeIconEdges(plateOn(CLEAR, BLACK, 8), 64, 64);
    for (const side of [result.trim.left, result.trim.top, result.trim.right, result.trim.bottom]) {
      expect(side).toBeCloseTo(8 / 64, 5);
    }
    expect(result.background).toEqual({ r: 18, g: 18, b: 18 });
  });

  it('does not let a soft shadow around the plate (low alpha) widen the box', () => {
    const shadow: Rgba = [12, 12, 12, 60];
    const data = pixels(64, (x, y) => {
      if (inside(x, 10, 54) && inside(y, 10, 54)) return BLACK;
      return inside(x, 6, 58) && inside(y, 6, 62) ? shadow : CLEAR;
    });
    const result = analyzeIconEdges(data, 64, 64);
    expect(result.trim.left).toBeCloseTo(10 / 64, 5);
    expect(result.trim.top).toBeCloseTo(10 / 64, 5);
    expect(result.trim.bottom).toBeCloseTo(10 / 64, 5);
  });

  it('trims a white margin around a colored plate (and one more pixel for the blended seam)', () => {
    const result = analyzeIconEdges(plateOn(WHITE, BLUE, 6), 64, 64);
    for (const side of [result.trim.left, result.trim.top, result.trim.right, result.trim.bottom]) {
      expect(side).toBeCloseTo(7 / 64, 5);
    }
    expect(result.background).toEqual({ r: 30, g: 120, b: 200 });
  });

  it('trims a margin of any flat color, not only white', () => {
    const result = analyzeIconEdges(plateOn(AMBER, BLACK, 5), 64, 64);
    expect(result.trim.left).toBeCloseTo(6 / 64, 5);
    expect(result.trim.bottom).toBeCloseTo(6 / 64, 5);
    expect(result.background).toEqual({ r: 18, g: 18, b: 18 });
  });

  it('trims each side by its own margin', () => {
    const data = pixels(64, (x, y) => (inside(x, 4, 58) && inside(y, 10, 56) ? BLACK : CLEAR));
    const { trim } = analyzeIconEdges(data, 64, 64);
    expect(trim.left).toBeCloseTo(4 / 64, 5);
    expect(trim.right).toBeCloseTo(6 / 64, 5);
    expect(trim.top).toBeCloseTo(10 / 64, 5);
    expect(trim.bottom).toBeCloseTo(8 / 64, 5);
  });

  it('trims nothing from a full-bleed icon and still reports its edge color', () => {
    const data = pixels(64, (x, y) => [40 + x, 90, 160 - y, 255]);
    const result = analyzeIconEdges(data, 64, 64);
    expect(result.trim).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(result.background).not.toBeNull();
  });

  it('keeps a plate whose flat color is its own background (a logo floating on a black plate)', () => {
    const data = pixels(64, (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? GREEN : BLACK));
    const result = analyzeIconEdges(data, 64, 64);
    expect(result.trim).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(result.background).toEqual({ r: 18, g: 18, b: 18 });
  });

  it('keeps the black plate of an icon that also has a transparent margin and a logo inside', () => {
    const data = pixels(64, (x, y) => {
      if (!inside(x, 6, 58) || !inside(y, 6, 58)) return CLEAR;
      return Math.hypot(x - 32, y - 32) < 12 ? BLUE : BLACK;
    });
    const result = analyzeIconEdges(data, 64, 64);
    expect(result.trim.left).toBeCloseTo(6 / 64, 5);
    expect(result.trim.top).toBeCloseTo(6 / 64, 5);
    expect(result.background).toEqual({ r: 18, g: 18, b: 18 });
  });

  it('trims the corners of a rounded plate like a plate (the transparent corners do not make it free-form)', () => {
    const radius = 12;
    const data = pixels(64, (x, y) => {
      if (!inside(x, 6, 58) || !inside(y, 6, 58)) return CLEAR;
      const dx = Math.max(6 + radius - x, x - (57 - radius), 0);
      const dy = Math.max(6 + radius - y, y - (57 - radius), 0);
      return Math.hypot(dx, dy) > radius ? CLEAR : BLACK;
    });
    const result = analyzeIconEdges(data, 64, 64);
    expect(result.trim.left).toBeCloseTo(6 / 64, 5);
    expect(result.background).toEqual({ r: 18, g: 18, b: 18 });
  });

  it('keeps a breathing room around a free-form drawing on a transparent background', () => {
    const ring = pixels(64, (x, y) => {
      const d = Math.hypot(x - 32, y - 32);
      return d > 18 && d < 26 ? BLUE : CLEAR;
    });
    const result = analyzeIconEdges(ring, 64, 64);
    // A margem é de 6 px (9,4%): sobra a folga de 7%, só o resto é aparado.
    expect(result.trim.left).toBeGreaterThan(0);
    expect(result.trim.left).toBeLessThan(0.05);
    expect(result.background).toBeNull();
  });

  it('does not trim the side where a free-form drawing touches the border', () => {
    const data = pixels(64, (x, y) =>
      Math.hypot(x - 32, y - 28) < 20 || (inside(x, 28, 36) && y < 10) ? BLUE : CLEAR,
    );
    const { trim } = analyzeIconEdges(data, 64, 64);
    expect(trim.top).toBe(0);
  });

  it('does not trim a drawing that touches the border of a flat-colored icon', () => {
    const data = pixels(64, (x, y) => {
      if (x < 6 && inside(y, 20, 40)) return BLUE;
      return inside(x, 6, 58) && inside(y, 6, 58) ? BLACK : WHITE;
    });
    const { trim } = analyzeIconEdges(data, 64, 64);
    expect(trim.left).toBe(0);
  });

  it('never takes more than the limit from a side, however wide the margin', () => {
    const result = analyzeIconEdges(plateOn(CLEAR, BLACK, 20), 64, 64);
    expect(MAX_TRIM).toBe(0.18);
    for (const side of [result.trim.left, result.trim.top, result.trim.right, result.trim.bottom]) {
      expect(side).toBeCloseTo(MAX_TRIM, 5);
    }
    const flat = analyzeIconEdges(plateOn(WHITE, BLUE, 22), 64, 64);
    expect(flat.trim.left).toBeCloseTo(MAX_TRIM, 5);
    expect(flat.trim.bottom).toBeCloseTo(MAX_TRIM, 5);
  });

  it('trims the margin of an icon that is not square (as long as the buffer says so)', () => {
    const data = pixels(64, (x, y) => (inside(x, 4, 60) && inside(y, 8, 24) ? BLUE : CLEAR), 36);
    const { trim } = analyzeIconEdges(data, 64, 36);
    expect(trim.left).toBeCloseTo(4 / 64, 5);
    // A margem de cima passa de 18% da altura: o corte para no limite.
    expect(trim.top).toBeCloseTo(MAX_TRIM, 5);
  });

  it('is not fooled by a stray pixel in the margin', () => {
    const data = plateOn(CLEAR, BLACK, 8);
    data.set(BLACK, (2 * 64 + 30) * 4);
    const { trim } = analyzeIconEdges(data, 64, 64);
    expect(trim.top).toBeCloseTo(8 / 64, 5);
  });

  it('absorbs mild noise in a flat margin and gives up on heavy noise', () => {
    let seed = 7;
    const noise = (amount: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.round(((seed >>> 8) / 2 ** 24 - 0.5) * 2 * amount);
    };
    const noisy = (amount: number) =>
      pixels(64, (x, y) => {
        if (inside(x, 8, 56) && inside(y, 8, 56)) return BLUE;
        return [255 + Math.min(0, noise(amount)), 255 + Math.min(0, noise(amount)), 255, 255];
      });
    expect(analyzeIconEdges(noisy(8), 64, 64).trim.left).toBeGreaterThan(0.1);
    expect(analyzeIconEdges(noisy(120), 64, 64).trim).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
  });

  it('trims nothing from an image of a single color, opaque or transparent', () => {
    for (const color of [WHITE, BLACK, CLEAR]) {
      const result = analyzeIconEdges(
        pixels(32, () => color),
        32,
        32,
      );
      expect(result.trim).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    }
  });

  it('refuses what it cannot read safely: tiny images, a short buffer and sizes that are not whole numbers', () => {
    const nothing = { trim: { left: 0, top: 0, right: 0, bottom: 0 }, background: null };
    expect(analyzeIconEdges(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1)).toEqual(nothing);
    expect(analyzeIconEdges(new Uint8ClampedArray(3 * 3 * 4), 3, 3)).toEqual(nothing);
    expect(analyzeIconEdges(new Uint8ClampedArray(10), 8, 8)).toEqual(nothing);
    expect(analyzeIconEdges(new Uint8ClampedArray(64 * 4), 8.5, 8)).toEqual(nothing);
    expect(analyzeIconEdges(new Uint8ClampedArray(0), 0, 0)).toEqual(nothing);
  });
});

describe('cropSquare', () => {
  it('is the whole image when nothing is trimmed', () => {
    expect(cropSquare({ left: 0, top: 0, right: 0, bottom: 0 })).toEqual({ x: 0, y: 0, size: 1 });
  });

  it('takes the larger side of the box that is left, centered on it', () => {
    const crop = cropSquare({ left: 0.1, top: 0.1, right: 0.1, bottom: 0.14 });
    expect(crop.size).toBeCloseTo(0.8, 5);
    expect(crop.x).toBeCloseTo(0.1, 5);
    expect(crop.y).toBeCloseTo(0.08, 5);
  });

  it('keeps the square inside the image when the box is off to one side', () => {
    const crop = cropSquare({ left: 0, top: 0.4, right: 0.5, bottom: 0.4 });
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.size).toBeLessThanOrEqual(1 + 1e-9);
    expect(crop.y + crop.size).toBeLessThanOrEqual(1 + 1e-9);
    expect(crop.size).toBeCloseTo(0.5, 5);
  });
});

describe('iconFit', () => {
  it('turns the crop into one scale and one translation from the top-left corner, and the color into rgb()', () => {
    const fit = iconFit({
      trim: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
      background: { r: 18, g: 18, b: 18 },
    });
    expect(fit.transform).toBe('scale(1.25) translate(-10%, -10%)');
    expect(fit.background).toBe('rgb(18 18 18)');
  });

  it('leaves the image alone when there is next to nothing to trim, and has no background without a plate', () => {
    const fit = iconFit({ trim: { left: 0, top: 0.002, right: 0, bottom: 0 }, background: null });
    expect(fit.transform).toBeNull();
    expect(fit.background).toBeNull();
  });
});

describe('reading the pixels of an image', () => {
  const image = (width: number, height: number) =>
    ({ naturalWidth: width, naturalHeight: height }) as HTMLImageElement;

  afterEach(() => vi.restoreAllMocks());

  it('draws the middle square of a banner onto a small canvas, the same cut that cover makes', () => {
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(ANALYSIS_SIDE ** 2 * 4) }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      getImageData,
      imageSmoothingQuality: 'low',
    } as unknown as CanvasRenderingContext2D);
    const read = readIconPixels(image(320, 180));
    expect(read).toMatchObject({ width: ANALYSIS_SIDE, height: ANALYSIS_SIDE });
    const args = drawImage.mock.calls[0];
    expect(args.slice(1)).toEqual([70, 0, 180, 180, 0, 0, ANALYSIS_SIDE, ANALYSIS_SIDE]);
  });

  it('gives up quietly: no canvas, an empty image or a refused read', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(readIconPixels(image(96, 96))).toBeNull();
    expect(readIconPixels(image(0, 0))).toBeNull();
    spy.mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => {
        throw new Error('tainted');
      },
    } as unknown as CanvasRenderingContext2D);
    expect(readIconPixels(image(96, 96))).toBeNull();
  });

  it('turns pixels into a fit, and into nothing when the reader fails or throws', () => {
    const data = plateOn(CLEAR, BLACK, 8);
    const fit = fitFromImage(image(96, 96), () => ({ data, width: 64, height: 64 }));
    expect(fit?.transform).toBe('scale(1.333) translate(-12.5%, -12.5%)');
    expect(fit?.background).toBe('rgb(18 18 18)');
    expect(fitFromImage(image(96, 96), () => null)).toBeNull();
    expect(
      fitFromImage(image(96, 96), () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });
});

describe('the in-memory cache', () => {
  beforeEach(() => resetIconFitCache());

  it('tells a measured icon, a failed measure and an icon never seen apart', () => {
    expect(cachedIconFit('a')).toBeUndefined();
    rememberIconFit('a', null);
    expect(cachedIconFit('a')).toBeNull();
    const fit = iconFit({
      trim: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
      background: null,
    });
    rememberIconFit('b', fit);
    expect(cachedIconFit('b')).toBe(fit);
  });

  it('is bounded: the oldest entry leaves first', () => {
    for (let index = 0; index < 300; index++) rememberIconFit(`icon-${index}`, null);
    expect(cachedIconFit('icon-0')).toBeUndefined();
    expect(cachedIconFit('icon-43')).toBeUndefined();
    expect(cachedIconFit('icon-44')).toBeNull();
    expect(cachedIconFit('icon-299')).toBeNull();
  });
});
