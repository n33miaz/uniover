import { TestBed } from '@angular/core/testing';
import { makeShortcut, pngIcon, webpIcon } from '../tv-test-kit';
import { AppIconSubject } from './app-icon-source';
import { AppIcon } from './app-icon';

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
    expect(host.classList.contains('wide')).toBe(false);
    expect(fallback()).toBeNull();
    expect(host.textContent?.trim()).toBe('');
  });

  it('gives a 16:9 banner a wider tile before it loads, so nothing jumps afterwards', () => {
    show(makeShortcut(1, { iconDataUri: pngIcon(320, 180) }));
    expect(host.classList.contains('wide')).toBe(true);
    expect([image()!.getAttribute('width'), image()!.getAttribute('height')]).toEqual([
      '192',
      '108',
    ]);
  });

  it('also draws a WebP', () => {
    show(makeShortcut(1, { iconDataUri: webpIcon('lossless', 128, 128) }));
    expect(image()).not.toBeNull();
    expect(host.classList.contains('wide')).toBe(false);
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
});
