import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TV_SUGGESTED_APPS } from '../data/tv-suggestions';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { ShortcutRow, TvSuggestionRequest } from './shortcut-row';

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
      expect(hint()).toBe('Fixe apps aqui: abra o menu, no topo.');
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
      expect(hint()).toBe('Fixe apps aqui: abra o menu, no topo.');
    });

    it('gives way to the tiles when a shortcut is pinned', () => {
      empty();
      fixture.componentRef.setInput('shortcuts', [makeShortcut(1)]);
      fixture.detectChanges();
      expect(root.querySelector('.hint')).toBeNull();
      expect(names()).toEqual(['Atalho 1']);
    });
  });

  describe('suggestions on a TV with no shortcut chosen', () => {
    let widthOfStrip = 358;
    let observed: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
    const suggestions = () => [...root.querySelectorAll<HTMLButtonElement>('.shortcut.suggestion')];
    const suggestionNames = () => suggestions().map((el) => el.getAttribute('aria-label'));

    /** Monta a fileira de novo com a faixa medindo `widthOfStrip` (o jsdom não faz layout: a medida vem do dublê). */
    const mount = (shortcuts: TvShortcut[] = [], guest = false) => {
      TestBed.resetTestingModule();
      store = createFakeTvStore();
      TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
      if (guest) {
        TestBed.inject(SessionState).setUser({
          id: '1',
          email: 'a@b.c',
          displayName: 'Alice',
          role: 'guest',
          permissions: ['module:tv', 'tv:control', 'tv:launch'],
        });
      }
      fixture = TestBed.createComponent(ShortcutRow);
      fixture.componentRef.setInput('shortcuts', shortcuts);
      fixture.detectChanges();
      root = fixture.nativeElement;
      fixture.detectChanges();
    };

    beforeEach(() => {
      widthOfStrip = 358;
      observed = null;
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widthOfStrip);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
            observed = callback;
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      TestBed.inject(TvPrefs).reset();
    });

    it('offers as many known apps as fit the measured width with room to spare, in catalog order', () => {
      mount();
      expect(suggestionNames()).toEqual([
        'Sugestão: YouTube',
        'Sugestão: Netflix',
        'Sugestão: Prime Video',
        'Sugestão: Max',
        'Sugestão: Disney+',
      ]);
      expect(root.querySelector('.hint')).toBeNull();
    });

    it('recounts when the strip changes size', () => {
      mount();
      observed?.([{ contentRect: { width: 328 } }]);
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(4);
      observed?.([{ contentRect: { width: 120 } }]);
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(1);
    });

    it('never fills more than the catalog has, however wide the strip is', () => {
      widthOfStrip = 900;
      mount();
      expect(suggestions()).toHaveLength(TV_SUGGESTED_APPS.length);
    });

    it('looks like a suggestion, not like a shortcut: a labelled button that opens a dialog, with no pretence of an app', () => {
      mount();
      const first = suggestions()[0]!;
      expect(first.getAttribute('aria-haspopup')).toBe('dialog');
      expect(first.getAttribute('title')).toBe('Sugestão: YouTube');
      expect(first.querySelectorAll('app-tv-app-icon')).toHaveLength(1);
      expect(root.querySelector('ul.shortcuts')!.getAttribute('aria-label')).toBe(
        'Sugestões de atalhos',
      );
      // Nenhum botão de atalho de verdade (não abre app nenhum).
      expect(tiles().filter((el) => !el.classList.contains('suggestion'))).toHaveLength(0);
    });

    it('tells the screen which app and which button was tapped', () => {
      mount();
      const requests: TvSuggestionRequest[] = [];
      fixture.componentInstance.suggest.subscribe((request) => requests.push(request));
      suggestions()[1]!.click();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.app.key).toBe('netflix');
      expect(requests[0]!.opener).toBe(suggestions()[1]);
    });

    it('does not offer an app the person removed, and fills its place with the next one', () => {
      mount();
      TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['netflix'] });
      fixture.detectChanges();
      expect(suggestionNames()).toEqual([
        'Sugestão: YouTube',
        'Sugestão: Prime Video',
        'Sugestão: Max',
        'Sugestão: Disney+',
        'Sugestão: Globoplay',
      ]);
    });

    it('falls back to the hint once every suggestion was removed, and when nothing can be measured', () => {
      mount();
      TestBed.inject(TvPrefs).set({
        dismissedSuggestions: TV_SUGGESTED_APPS.map((app) => app.key),
      });
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(0);
      expect(hint()).toBe('Fixe apps aqui: abra o menu, no topo.');
      TestBed.inject(TvPrefs).reset();
      widthOfStrip = 0;
      mount();
      expect(suggestions()).toHaveLength(0);
      expect(hint()).toBe('Fixe apps aqui: abra o menu, no topo.');
    });

    it('is only for who can edit the shortcuts: a guest keeps the plain hint', () => {
      mount([], true);
      expect(suggestions()).toHaveLength(0);
      expect(hint()).toBe('Nenhum app fixado no controle.');
    });

    it('gives way to the real shortcuts as soon as one is chosen, and waits while the list has not arrived', () => {
      mount([makeShortcut(1)]);
      expect(suggestions()).toHaveLength(0);
      expect(names()).toEqual(['Atalho 1']);
      mount();
      store.shortcuts.set(null);
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(0);
      expect(root.querySelector('.hint')).toBeNull();
    });
  });
});
