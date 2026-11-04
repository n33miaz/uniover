import {
  DecodedPhoto,
  PHOTO_MAX_BYTES,
  PHOTO_QUALITIES,
  PhotoSize,
  createPhotoReducer,
  fitPhoto,
  fitWithin,
} from './photo-fit';

describe('fitWithin', () => {
  it('fits inside 1920x1080, not only the longest side', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1440, height: 1080 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 810, height: 1080 });
    expect(fitWithin(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  it('never enlarges a photo that already fits', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('never goes under one pixel on a very long strip', () => {
    expect(fitWithin(40000, 10)).toEqual({ width: 1920, height: 1 });
  });
});

/** Um JPEG de mentira cujo peso depende do tamanho e da qualidade, como o de verdade (sem tela de desenho). */
function weigh(size: PhotoSize, quality: number): { size: number } {
  return { size: Math.round(size.width * size.height * quality * 0.6) };
}

describe('fitPhoto', () => {
  it('keeps the best quality when the photo already fits', async () => {
    const sizes: PhotoSize[] = [];
    const result = await fitPhoto({ width: 640, height: 480 }, async (size, quality) => {
      sizes.push(size);
      return { ...weigh(size, quality), quality };
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.quality).toBe(PHOTO_QUALITIES[0]);
    expect(result.size).toEqual({ width: 640, height: 480 });
    expect(sizes).toHaveLength(1);
  });

  it('lowers the quality step by step until it fits in 400 KB, at the reduced size', async () => {
    const tries: { size: PhotoSize; quality: number }[] = [];
    const result = await fitPhoto({ width: 4000, height: 3000 }, async (size, quality) => {
      tries.push({ size, quality });
      return weigh(size, quality);
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.size).toEqual({ width: 1440, height: 1080 });
    expect(result.blob.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    // As qualidades acima da escolhida estouraram o limite, na ordem, e a escolhida é a primeira que coube.
    const qualities = tries.map((t) => t.quality);
    expect(qualities).toEqual(PHOTO_QUALITIES.slice(0, qualities.length));
    expect(qualities.at(-1)).toBe(result.quality);
    expect(qualities.length).toBeGreaterThan(1);
    for (const failed of tries.slice(0, -1)) {
      expect(weigh(failed.size, failed.quality).size).toBeGreaterThan(PHOTO_MAX_BYTES);
    }
  });

  it('shrinks the image when not even the worst quality fits, and tries again', async () => {
    const sizes = new Set<string>();
    const result = await fitPhoto({ width: 1920, height: 1080 }, async (size, quality) => {
      sizes.add(`${size.width}x${size.height}`);
      // Pesado de propósito: só cabe no tamanho reduzido.
      return { size: Math.round(size.width * size.height * quality * 1.2) };
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.size.width).toBeLessThan(1920);
    expect(sizes.size).toBeGreaterThan(1);
    expect(result.blob.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
  });

  it('gives up with "too-big" when nothing fits', async () => {
    const result = await fitPhoto({ width: 100, height: 100 }, async () => ({
      size: PHOTO_MAX_BYTES + 1,
    }));
    expect(result.status).toBe('too-big');
  });

  it('is invalid when the encoder cannot draw, or the image has no size', async () => {
    expect((await fitPhoto({ width: 100, height: 100 }, async () => null)).status).toBe('invalid');
    expect((await fitPhoto({ width: 0, height: 10 }, async () => ({ size: 1 }))).status).toBe(
      'invalid',
    );
  });
});

describe('createPhotoReducer', () => {
  it('reads the file, fits it and always releases the image', async () => {
    const release = vi.fn();
    const draw = vi.fn(async (size: PhotoSize, quality: number) => {
      return new Blob([new Uint8Array(weigh(size, quality).size)], { type: 'image/jpeg' });
    });
    const image: DecodedPhoto = { width: 3000, height: 4000, draw, release };
    const reduce = createPhotoReducer({ decode: async () => image });
    const result = await reduce(new Blob(['x']));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.size).toEqual({ width: 810, height: 1080 });
    expect(result.blob.type).toBe('image/jpeg');
    expect(result.blob.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('is invalid for a file the browser cannot decode', async () => {
    const reduce = createPhotoReducer({ decode: async () => null });
    expect((await reduce(new Blob(['x']))).status).toBe('invalid');
  });
});
