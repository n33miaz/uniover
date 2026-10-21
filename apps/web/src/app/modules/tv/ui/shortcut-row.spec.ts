import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { ShortcutRow } from './shortcut-row';

describe('ShortcutRow', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ShortcutRow>>;
  let root: HTMLElement;
  let opened: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;

  const tiles = () => [...root.querySelectorAll<HTMLButtonElement>('.shortcut')];
  const names = () => tiles().map((el) => el.getAttribute('aria-label'));
  const hint = () => root.querySelector('.hint')?.textContent?.trim();

  // O papel fica guardado no navegador (dica da sessão): um teste de convidado não pode vazar para o seguinte.
  afterEach(() => localStorage.clear());

  beforeEach(() => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(ShortcutRow);
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1),
      makeShortcut(2, { customLabel: 'Sala' }),
    ]);
    opened = vi.fn<(shortcut: TvShortcut) => void>();
    fixture.componentInstance.open.subscribe(opened);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  it('is only the shortcuts, named by position or by the owner: no Apps chip and no output for it', () => {
    expect(root.querySelector('.apps-chip')).toBeNull();
    expect(root.querySelector('.top > ul.shortcuts')).not.toBeNull();
    expect(root.querySelector('.hint')).toBeNull();
    expect(names()).toEqual(['Atalho 1', 'Sala']);
    expect('apps' in fixture.componentInstance).toBe(false);
  });

  it('shows the app icon instead of the name, and keeps the name as the accessible name and the hover hint', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'CineVS', iconDataUri: pngIcon(320, 180) }),
      makeShortcut(2, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }),
    ]);
    fixture.detectChanges();
    expect(names()).toEqual(['CineVS', 'Spotify']);
    expect(tiles().map((el) => el.getAttribute('title'))).toEqual(['CineVS', 'Spotify']);
    for (const tile of tiles()) {
      expect(tile.querySelectorAll('app-tv-app-icon img')).toHaveLength(1);
      expect(tile.querySelector('img')!.getAttribute('alt')).toBe('');
      expect(tile.textContent?.trim()).toBe('');
      expect(tile.querySelector('.name')).toBeNull();
    }
  });

  it('gives every tile the same square shape, a banner included: none is marked as wide', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'CineVS', iconDataUri: pngIcon(320, 180) }),
      makeShortcut(2, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }),
      makeShortcut(3),
    ]);
    fixture.detectChanges();
    for (const icon of root.querySelectorAll('.shortcut app-tv-app-icon')) {
      expect(icon.classList.contains('wide')).toBe(false);
    }
  });

  it('shows a tile with the initial (or the position, for "Atalho n") for an app without an icon, hidden from readers', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1),
      makeShortcut(2, { customLabel: 'Sala' }),
      makeShortcut(3, { tvLabel: 'YouTube', iconDataUri: null }),
    ]);
    fixture.detectChanges();
    const fallbacks = [...root.querySelectorAll<HTMLElement>('.shortcut .fallback')];
    expect(fallbacks.map((tile) => tile.textContent?.trim())).toEqual(['1', 'S', 'Y']);
    expect(fallbacks.every((tile) => tile.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(names()).toEqual(['Atalho 1', 'Sala', 'YouTube']);
  });

  it('keeps the tiles in the order they were given, whatever they show', () => {
    fixture.componentRef.setInput('shortcuts', [
      makeShortcut(1, { tvLabel: 'Um', iconDataUri: pngIcon(96, 96) }),
      makeShortcut(2, { tvLabel: 'Dois' }),
      makeShortcut(3, { tvLabel: 'Três', iconDataUri: pngIcon(320, 180) }),
    ]);
    fixture.detectChanges();
    expect(names()).toEqual(['Um', 'Dois', 'Três']);
  });

  it('tells which shortcut was tapped', () => {
    tiles()[1].click();
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

  it('dims the tiles without taking them out of the tab order when it cannot send', () => {
    expect(tiles()[0].hasAttribute('aria-disabled')).toBe(false);
    fixture.componentRef.setInput('canSend', false);
    fixture.detectChanges();
    expect(tiles()[0].getAttribute('aria-disabled')).toBe('true');
    expect(tiles()[0].disabled).toBe(false);
  });

  describe('without permission to open apps', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('launchable', false);
      fixture.detectChanges();
    });

    it('draws the same tiles as figures: no button, still named by the app, and no way to open anything', () => {
      expect(root.querySelectorAll('button')).toHaveLength(0);
      const figures = [...root.querySelectorAll<HTMLElement>('.shortcut.still')];
      expect(figures.map((el) => el.getAttribute('aria-label'))).toEqual(['Atalho 1', 'Sala']);
      expect(figures.map((el) => el.getAttribute('role'))).toEqual(['img', 'img']);
      expect(figures.map((el) => el.getAttribute('title'))).toEqual(['Atalho 1', 'Sala']);
      figures[0].click();
      expect(opened).not.toHaveBeenCalled();
    });

    it('gives the strip itself the keyboard focus, since it scrolls and nothing inside can take it', () => {
      expect(root.querySelector('ul.shortcuts')!.getAttribute('tabindex')).toBe('0');
    });

    it('keeps the tile size, so the row does not change height or width', () => {
      expect(root.querySelectorAll('.top > ul.shortcuts > li')).toHaveLength(2);
      expect(root.querySelectorAll('.shortcut app-tv-app-icon')).toHaveLength(2);
    });

    it('goes back to buttons, and the strip leaves the tab order, when the permission comes', () => {
      fixture.componentRef.setInput('launchable', true);
      fixture.detectChanges();
      expect(tiles()).toHaveLength(2);
      expect(root.querySelectorAll('.shortcut.still')).toHaveLength(0);
      expect(root.querySelector('ul.shortcuts')!.hasAttribute('tabindex')).toBe(false);
    });
  });

  describe('with no active shortcut', () => {
    const empty = () => {
      fixture.componentRef.setInput('shortcuts', []);
      fixture.detectChanges();
    };

    it('shows a quiet hint where to pin apps, not a button and not an error', () => {
      empty();
      expect(tiles()).toHaveLength(0);
      expect(root.querySelector('ul')).toBeNull();
      expect(hint()).toBe('Fixe apps aqui: abra Apps, no topo.');
      expect(root.querySelector('.hint')!.closest('button, a')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('does not tell a guest to pin anything (only the owner can)', () => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'Alice',
        role: 'guest',
        permissions: ['module:tv', 'tv:control', 'tv:launch'],
      });
      empty();
      expect(hint()).toBe('Nenhum app fixado no controle.');
    });

    it('says nothing while the list has not arrived yet, and the hint takes over once it is known to be empty', () => {
      store.shortcuts.set(null);
      empty();
      expect(root.querySelector('.hint')).toBeNull();
      store.shortcuts.set([]);
      fixture.detectChanges();
      expect(hint()).toBe('Fixe apps aqui: abra Apps, no topo.');
    });

    it('gives way to the tiles when a shortcut is pinned', () => {
      empty();
      fixture.componentRef.setInput('shortcuts', [makeShortcut(1)]);
      fixture.detectChanges();
      expect(root.querySelector('.hint')).toBeNull();
      expect(names()).toEqual(['Atalho 1']);
    });
  });
});
