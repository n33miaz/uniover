import {
  type BrowserImageEnv,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_SIDE,
  createBrowserPhotoEncoder,
  scaledSize,
} from './photo-encoder';

describe('photo encoder constants', () => {
  it('keeps the longest side at 1280 px and the JPEG quality at 0,8', () => {
    expect(PHOTO_MAX_SIDE).toBe(1280);
    expect(PHOTO_JPEG_QUALITY).toBe(0.8);
  });
});

describe('scaledSize', () => {
  it('shrinks the longest side to the limit and keeps the proportion', () => {
    expect(scaledSize(4032, 3024, 1280)).toEqual({ width: 1280, height: 960 });
    expect(scaledSize(3024, 4032, 1280)).toEqual({ width: 960, height: 1280 });
    expect(scaledSize(4000, 4000, 1280)).toEqual({ width: 1280, height: 1280 });
  });

  it('never enlarges a photo that is already small', () => {
    expect(scaledSize(800, 600, 1280)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(1280, 720, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('never returns a side under one pixel, even for a very long strip', () => {
    expect(scaledSize(20000, 1, 1280)).toEqual({ width: 1280, height: 1 });
  });
});

interface Calls {
  bitmapOptions: (ImageBitmapOptions | undefined)[];
  closed: number;
  drawn: { width: number; height: number }[];
  quality: number | null;
  fills: number;
  canvas: { width: number; height: number };
}

function fakeEnv(options: {
  bitmap?: { width: number; height: number };
  failFirstWithTypeError?: boolean;
  failWith?: unknown;
  noContext?: boolean;
  noBlob?: boolean;
}): { env: BrowserImageEnv; calls: Calls } {
  const calls: Calls = {
    bitmapOptions: [],
    closed: 0,
    drawn: [],
    quality: null,
    fills: 0,
    canvas: { width: -1, height: -1 },
  };
  const bitmap = options.bitmap ?? { width: 4032, height: 3024 };
  let attempts = 0;
  const env: BrowserImageEnv = {
    createImageBitmap: async (_file, opts) => {
      calls.bitmapOptions.push(opts);
      attempts += 1;
      if (options.failWith !== undefined) throw options.failWith;
      if (options.failFirstWithTypeError && attempts === 1) throw new TypeError('opção');
      return { ...bitmap, close: () => (calls.closed += 1) } as ImageBitmap;
    },
    createCanvas: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () =>
          options.noContext
            ? null
            : {
                fillStyle: '',
                fillRect: () => (calls.fills += 1),
                drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) =>
                  calls.drawn.push({ width: w, height: h }),
              },
        toBlob: (callback: (blob: Blob | null) => void, _type: string, quality: number) => {
          calls.quality = quality;
          callback(options.noBlob ? null : new Blob(['jpeg'], { type: 'image/jpeg' }));
        },
      };
      // Guarda a referência para conferir que a tela de desenho foi zerada no fim.
      Object.defineProperty(calls, 'canvas', {
        get: () => ({ width: canvas.width, height: canvas.height }),
      });
      return canvas as unknown as HTMLCanvasElement;
    },
  };
  return { env, calls };
}

describe('browser photo encoder', () => {
  const file = new Blob(['x'], { type: 'image/heic' });

  it('decodes with the photo orientation, draws it reduced on a white background and encodes a JPEG', async () => {
    const { env, calls } = fakeEnv({});

    const encoded = await createBrowserPhotoEncoder(env).encode(file, {
      maxSide: 1280,
      quality: 0.8,
    });

    expect(encoded).not.toBeNull();
    expect(encoded).toMatchObject({ width: 1280, height: 960 });
    expect(encoded?.blob.type).toBe('image/jpeg');
    expect(calls.bitmapOptions).toEqual([{ imageOrientation: 'from-image' }]);
    expect(calls.drawn).toEqual([{ width: 1280, height: 960 }]);
    expect(calls.fills).toBe(1);
    expect(calls.quality).toBe(0.8);
  });

  it('releases the bitmap and the canvas memory when done', async () => {
    const { env, calls } = fakeEnv({});

    await createBrowserPhotoEncoder(env).encode(file, { maxSide: 1280, quality: 0.8 });

    expect(calls.closed).toBe(1);
    expect(calls.canvas).toEqual({ width: 0, height: 0 });
  });

  it('tries again without the orientation option on a browser that does not know it', async () => {
    const { env, calls } = fakeEnv({ failFirstWithTypeError: true });

    const encoded = await createBrowserPhotoEncoder(env).encode(file, {
      maxSide: 1280,
      quality: 0.8,
    });

    expect(encoded).not.toBeNull();
    expect(calls.bitmapOptions).toEqual([{ imageOrientation: 'from-image' }, undefined]);
  });

  it('is null when the file is not an image the browser decodes', async () => {
    const decoding = fakeEnv({ failWith: new DOMException('não decodifica', 'InvalidStateError') });

    expect(
      await createBrowserPhotoEncoder(decoding.env).encode(file, { maxSide: 1280, quality: 0.8 }),
    ).toBeNull();
    expect(decoding.calls.closed).toBe(0);
  });

  it('is null when there is no drawing context or the browser cannot encode, and still releases the bitmap', async () => {
    const noContext = fakeEnv({ noContext: true });
    const noBlob = fakeEnv({ noBlob: true });

    expect(
      await createBrowserPhotoEncoder(noContext.env).encode(file, { maxSide: 1280, quality: 0.8 }),
    ).toBeNull();
    expect(
      await createBrowserPhotoEncoder(noBlob.env).encode(file, { maxSide: 1280, quality: 0.8 }),
    ).toBeNull();
    expect(noContext.calls.closed).toBe(1);
    expect(noBlob.calls.closed).toBe(1);
  });

  it('does not enlarge a small photo', async () => {
    const { env, calls } = fakeEnv({ bitmap: { width: 640, height: 480 } });

    const encoded = await createBrowserPhotoEncoder(env).encode(file, {
      maxSide: 1280,
      quality: 0.8,
    });

    expect(encoded).toMatchObject({ width: 640, height: 480 });
    expect(calls.drawn).toEqual([{ width: 640, height: 480 }]);
  });
});
