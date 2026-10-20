import { TestBed } from '@angular/core/testing';
import { TvShortcut } from '../data/tv-types';
import { makeShortcut, pngIcon } from '../tv-test-kit';
import { ShortcutRow } from './shortcut-row';

describe('ShortcutRow', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ShortcutRow>>;
  let root: HTMLElement;
  let askedApps: ReturnType<typeof vi.fn<(button: HTMLElement) => void>>;
  let opened: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;

  const chips = () => [...root.querySelectorAll<HTMLButtonElement>('.shortcut')];
  const names = () => chips().map((el) => el.getAttribute('aria-label'));

  beforeEach(() => {
    fixture = TestBed.createComponent(ShortcutRow);
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1),
      makeShortcut(2, { customLabel: 'Sala' }),
    ]);
    askedApps = vi.fn<(button: HTMLElement) => void>();
    opened = vi.fn<(shortcut: TvShortcut) => void>();
    fixture.componentInstance.apps.subscribe(askedApps);
    fixture.componentInstance.open.subscribe(opened);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('puts the fixed Apps chip first and the shortcuts, named by position or by the owner, after it', () => {
    const chip = root.querySelector<HTMLButtonElement>('.top > .apps-chip')!;
    expect(chip.textContent?.trim()).toBe('Apps');
    expect(chip.getAttribute('aria-label')).toBe('Apps da TV');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.closest('.shortcuts')).toBeNull();
    expect(names()).toEqual(['Atalho 1', 'Sala']);
  });

  it('shows the app icon instead of the name, and keeps the name as the accessible name and the hover hint', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'CineVS', iconDataUri: pngIcon(320, 180) }),
      makeShortcut(2, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }),
    ]);
    fixture.detectChanges();
    expect(names()).toEqual(['CineVS', 'Spotify']);
    expect(chips().map((el) => el.getAttribute('title'))).toEqual(['CineVS', 'Spotify']);
    for (const chip of chips()) {
      expect(chip.querySelectorAll('app-tv-app-icon img')).toHaveLength(1);
      expect(chip.querySelector('img')!.getAttribute('alt')).toBe('');
      expect(chip.textContent?.trim()).toBe('');
      expect(chip.querySelector('.name')).toBeNull();
    }
    expect(chips()[0].querySelector('app-tv-app-icon')!.classList.contains('wide')).toBe(true);
    expect(chips()[1].querySelector('app-tv-app-icon')!.classList.contains('wide')).toBe(false);
  });

  it('shows a tile with the initial (or the position, for "Atalho n") for an app without an icon, hidden from readers', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1),
      makeShortcut(2, { customLabel: 'Sala' }),
      makeShortcut(3, { tvLabel: 'YouTube', iconDataUri: null }),
    ]);
    fixture.detectChanges();
    const tiles = [...root.querySelectorAll<HTMLElement>('.shortcut .fallback')];
    expect(tiles.map((tile) => tile.textContent?.trim())).toEqual(['1', 'S', 'Y']);
    expect(tiles.every((tile) => tile.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(names()).toEqual(['Atalho 1', 'Sala', 'YouTube']);
  });

  it('keeps the chips in the order they were given, whatever they show', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'Um', iconDataUri: pngIcon(96, 96) }),
      makeShortcut(2, { tvLabel: 'Dois' }),
      makeShortcut(3, { tvLabel: 'Três', iconDataUri: pngIcon(320, 180) }),
    ]);
    fixture.detectChanges();
    expect(names()).toEqual(['Um', 'Dois', 'Três']);
  });

  it('hands over the Apps button itself, so the panel can give the focus back to it', () => {
    const chip = root.querySelector<HTMLButtonElement>('.apps-chip')!;
    chip.click();
    expect(askedApps).toHaveBeenCalledWith(chip);
  });

  it('tells which shortcut was tapped', () => {
    chips()[1].click();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
  });

  it('tapping the icon itself opens the app', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'CineVS', iconDataUri: pngIcon(320, 180) }),
    ]);
    fixture.detectChanges();
    root.querySelector<HTMLElement>('.shortcut img')!.click();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('dims the chips without taking them out of the tab order when it cannot send', () => {
    expect(chips()[0].hasAttribute('aria-disabled')).toBe(false);
    fixture.componentRef.setInput('canSend', false);
    fixture.detectChanges();
    expect(chips()[0].getAttribute('aria-disabled')).toBe('true');
    expect(chips()[0].disabled).toBe(false);
  });

  it('shows only the Apps chip when there are no shortcuts', () => {
    fixture.componentRef.setInput('shortcuts', []);
    fixture.detectChanges();
    expect(chips()).toHaveLength(0);
    expect(root.querySelector('.top')?.textContent?.trim()).toBe('Apps');
  });
});
