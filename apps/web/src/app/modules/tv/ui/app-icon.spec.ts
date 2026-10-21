import { TestBed } from '@angular/core/testing';
import { makeShortcut, pngIcon, webpIcon } from '../tv-test-kit';
import { AppIconSubject } from './app-icon-source';
import { AppIcon, ICON_PIXEL_READER } from './app-icon';
import { IconPixelReader, resetIconFitCache } from './app-icon-fit';

describe('AppIcon', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<AppIcon>>;
  let host: HTMLElement;

  const show = (shortcut: AppIconSubject, lazy = false) => {
    fixture = TestBed.createComponent(AppIcon);
    fixture.componentRef.setInput('shortcut', shortcut);
    fixture.componentRef.setInput('lazy', lazy);
    fixture.detectChanges();
    host = fixture.nativeElement;
  };
  const update = (shortcut: AppIconSubject) => {
    fixture.componentRef.setInput('shortcut', shortcut);
    fixture.detectChanges();
  };
  const image = () => host.querySelector<HTMLImageElement>('img');
  const fallback = () => host.querySelector<HTMLElement>('.fallback');

  it('draws a square icon as an image with no text of its own, from fixed dimensions', () => {
    const uri = pngIcon(96, 96);
    show(makeShortcut(1, { iconDataUri: uri }));
    const img = image()!;
    expect(img.getAttribute('src')).toBe(uri);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.getAttribute('loading')).toBe('eager');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['96', '96']);
    expect(fallback()).toBeNull();
    expect(host.textContent?.trim()).toBe('');
  });

  it('keeps every tile the same square: a 16:9 banner is not given a wider tile, only the same fixed dimensions', () => {
    show(makeShortcut(1, { iconDataUri: pngIcon(320, 180) }));
    expect(host.classList.contains('wide')).toBe(false);
    expect([image()!.getAttribute('width'), image()!.getAttribute('height')]).toEqual(['96', '96']);
    show(makeShortcut(2, { iconDataUri: pngIcon(90, 160) }));
    expect([image()!.getAttribute('width'), image()!.getAttribute('height')]).toEqual(['96', '96']);
    expect(host.className).not.toContain('wide');
  });

  it('also draws a WebP', () => {
    show(makeShortcut(1, { iconDataUri: webpIcon('lossless', 128, 128) }));
    expect(image()).not.toBeNull();
  });

  it('loads the image late only where it is asked to (the long list in the panel)', () => {
    show(makeShortcut(1, { iconDataUri: pngIcon(96, 96) }), true);
    expect(image()!.getAttribute('loading')).toBe('lazy');
  });

  it('without an icon shows the initial of the app name on a color of its package, hidden from readers', () => {
    show(makeShortcut(1, { tvLabel: 'Spotify', package: 'com.spotify.tv.android' }));
    expect(image()).toBeNull();
    const tile = fallback()!;
    expect(tile.textContent?.trim()).toBe('S');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.className).toMatch(/\bhue-[0-5]\b/);
  });

  it('keeps the same color for the same package, whatever the name', () => {
    show(makeShortcut(1, { customLabel: 'Sala', package: 'com.exemplo.video' }));
    const first = fallback()!.className;
    update(makeShortcut(2, { customLabel: 'Cinema', package: 'com.exemplo.video' }));
    expect(fallback()!.className).toBe(first);
  });

  it('shows the position number when the name is the default "Atalho n"', () => {
    show(makeShortcut(4));
    expect(fallback()!.textContent?.trim()).toBe('4');
  });

  it('treats a missing field (a row saved before the icons existed) and null as "no icon"', () => {
    const old: Partial<ReturnType<typeof makeShortcut>> = makeShortcut(2);
    delete old.iconDataUri;
    show(old as AppIconSubject);
    expect(image()).toBeNull();
    expect(fallback()!.textContent?.trim()).toBe('2');
    update(makeShortcut(2, { iconDataUri: null }));
    expect(image()).toBeNull();
  });

  it('refuses what is not a PNG or WebP in a data URI (no network address reaches the image)', () => {
    show(makeShortcut(1, { iconDataUri: 'https://exemplo.test/icone.png' }));
    expect(image()).toBeNull();
    expect(fallback()).not.toBeNull();
  });

  it('falls back to the tile when the image fails to load, and tries again for a new icon', () => {
    const broken = pngIcon(96, 96);
    show(makeShortcut(1, { customLabel: 'Sala', iconDataUri: broken }));
    image()!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(image()).toBeNull();
    expect(fallback()!.textContent?.trim()).toBe('S');

    update(makeShortcut(1, { customLabel: 'Sala', iconDataUri: broken }));
    expect(image()).toBeNull();

    update(makeShortcut(1, { customLabel: 'Sala', iconDataUri: pngIcon(64, 64) }));
    expect(image()).not.toBeNull();
  });

  it('goes from the tile to the image when the icon arrives later, and back when it is taken away', () => {
    show(makeShortcut(1, { customLabel: 'Sala' }));
    expect(image()).toBeNull();
    update(makeShortcut(1, { customLabel: 'Sala', iconDataUri: pngIcon(96, 96) }));
    expect(image()).not.toBeNull();
    update(makeShortcut(1, { customLabel: 'Sala', iconDataUri: null }));
    expect(image()).toBeNull();
    expect(fallback()).not.toBeNull();
  });

  describe('fitting the icon to the tile', () => {
    /** Uma placa preta com 8 px de margem transparente (em 64): o que o CineVS traz. */
    const plate = () => {
      const data = new Uint8ClampedArray(64 * 64 * 4);
      for (let y = 8; y < 56; y++) {
        for (let x = 8; x < 56; x++) data.set([18, 18, 18, 255], (y * 64 + x) * 4);
      }
      return { data, width: 64, height: 64 };
    };
    const loaded = (el: HTMLImageElement = image()!) => {
      el.dispatchEvent(new Event('load'));
      fixture.detectChanges();
    };
    const withReader = (reader: IconPixelReader) =>
      TestBed.configureTestingModule({
        providers: [{ provide: ICON_PIXEL_READER, useValue: reader }],
      });

    beforeEach(() => resetIconFitCache());

    it('shows a plain cover until the image has loaded, and trims the margin once it is measured', () => {
      const reader = vi.fn<IconPixelReader>(() => plate());
      withReader(reader);
      show(makeShortcut(1, { iconDataUri: pngIcon(96, 96) }));
      expect(image()!.style.transform).toBe('');
      expect(host.style.backgroundColor).toBe('');
      expect(reader).not.toHaveBeenCalled();

      loaded();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(image()!.style.transform).toBe('scale(1.333) translate(-12.5%, -12.5%)');
      expect(host.style.backgroundColor).toBe('rgb(18, 18, 18)');
    });

    it('measures an icon once: the same icon in another tile comes already trimmed, with no new reading', () => {
      const reader = vi.fn<IconPixelReader>(() => plate());
      withReader(reader);
      const uri = pngIcon(96, 96);
      show(makeShortcut(1, { iconDataUri: uri }));
      loaded();
      const first = fixture;

      show(makeShortcut(2, { iconDataUri: uri }));
      expect(image()!.style.transform).toBe('scale(1.333) translate(-12.5%, -12.5%)');
      loaded();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(first).not.toBe(fixture);
    });

    it('trims both tiles that load the same new icon at the same time, with a single reading', () => {
      const reader = vi.fn<IconPixelReader>(() => plate());
      withReader(reader);
      const uri = pngIcon(128, 128);
      show(makeShortcut(1, { iconDataUri: uri }));
      const firstImage = image()!;
      const firstHost = host;
      const firstFixture = fixture;
      show(makeShortcut(2, { iconDataUri: uri }));
      loaded(firstImage);
      firstFixture.detectChanges();
      loaded();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(firstImage.style.transform).toBe('scale(1.333) translate(-12.5%, -12.5%)');
      expect(image()!.style.transform).toBe('scale(1.333) translate(-12.5%, -12.5%)');
      expect(firstHost.style.backgroundColor).toBe('rgb(18, 18, 18)');
    });

    it('measures a new icon of the same app again, and goes back to a plain cover while it loads', () => {
      const reader = vi.fn<IconPixelReader>(() => plate());
      withReader(reader);
      show(makeShortcut(1, { iconDataUri: pngIcon(96, 96) }));
      loaded();
      update(makeShortcut(1, { iconDataUri: pngIcon(192, 192) }));
      expect(image()!.style.transform).toBe('');
      loaded();
      expect(reader).toHaveBeenCalledTimes(2);
    });

    it('stays a plain cover, without error, when there is no canvas to read the pixels from', () => {
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      show(makeShortcut(1, { iconDataUri: pngIcon(96, 96) }));
      Object.defineProperty(image()!, 'naturalWidth', { value: 96 });
      Object.defineProperty(image()!, 'naturalHeight', { value: 96 });
      expect(() => loaded()).not.toThrow();
      expect(image()!.style.transform).toBe('');
      expect(host.style.backgroundColor).toBe('');
      expect(fallback()).toBeNull();
      getContext.mockRestore();
    });

    it('stays a plain cover when the reading fails or throws, and does not try again for the same icon', () => {
      const reader = vi.fn<IconPixelReader>(() => {
        throw new Error('negado');
      });
      withReader(reader);
      const uri = pngIcon(96, 96);
      show(makeShortcut(1, { iconDataUri: uri }));
      expect(() => loaded()).not.toThrow();
      expect(image()!.style.transform).toBe('');
      show(makeShortcut(2, { iconDataUri: uri }));
      loaded();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(image()!.style.transform).toBe('');
    });

    it('does not trim an icon with nothing to trim, but still gives the tile the color of its edge', () => {
      withReader(() => {
        const data = new Uint8ClampedArray(64 * 64 * 4);
        for (let at = 0; at < data.length; at += 4) data.set([200, 60, 40, 255], at);
        return { data, width: 64, height: 64 };
      });
      show(makeShortcut(1, { iconDataUri: pngIcon(96, 96) }));
      loaded();
      expect(image()!.style.transform).toBe('');
      expect(host.style.backgroundColor).toBe('rgb(200, 60, 40)');
    });

    it('keeps the letter tile unchanged, with no background of its own', () => {
      show(makeShortcut(1, { customLabel: 'Sala' }));
      expect(fallback()).not.toBeNull();
      expect(host.style.backgroundColor).toBe('');
    });
  });
});
