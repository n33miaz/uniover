import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { ShortcutRow, TvPickRequest, TvSuggestionRequest } from './shortcut-row';

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

    it('says nothing while the list has not arrived yet, and says why once it is known to be empty', () => {
      store.shortcuts.set(null);
      empty();
      expect(root.querySelector('.hint')).toBeNull();
      expect(root.querySelector('app-tv-apps-unavailable')).toBeNull();
      store.shortcuts.set([]);
      fixture.detectChanges();
      // Nunca uma faixa vazia sem explicação: o motivo e o conserto de um toque.
      expect(root.querySelector('.hint')).toBeNull();
      const why = root.querySelector('app-tv-apps-unavailable')!;
      expect(why.textContent).toContain('A TV ainda não informou os apps instalados.');
      why.querySelector<HTMLButtonElement>('button')!.click();
      expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
    });

    it('draws a skeleton of tiles, same size as the real ones, only while the store says it is loading and the list is missing', () => {
      store.shortcuts.set(null);
      empty();
      expect(root.querySelector('.waiting')).toBeNull();
      store.shortcutsLoading.set(true);
      fixture.detectChanges();
      const slots = root.querySelectorAll('.waiting .ui-skeleton.tile');
      expect(slots).toHaveLength(4);
      expect(root.querySelector('.waiting')!.getAttribute('aria-hidden')).toBe('true');
      // Só a região dos atalhos fica ocupada para o leitor de tela.
      expect(root.querySelector('.top')!.getAttribute('aria-busy')).toBe('true');
      expect(root.querySelector('.hint')).toBeNull();
      store.shortcutsLoading.set(false);
      fixture.detectChanges();
      expect(root.querySelector('.waiting')).toBeNull();
      expect(root.querySelector('.top')!.getAttribute('aria-busy')).toBeNull();
    });

    it('never keeps the skeleton once the list is known, even if the store still says loading', () => {
      store.shortcutsLoading.set(true);
      empty();
      expect(root.querySelector('.waiting')).toBeNull();
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

    /** O que a TV informou: nenhum app no controle, as marcas conhecidas fora de ordem e um app que saiu da TV. */
    const tvApps = (): TvShortcut[] => [
      makeShortcut(1, { package: 'com.exemplo.zebra', tvLabel: 'Zebra', enabled: false }),
      makeShortcut(2, { package: 'com.globo.globotv', tvLabel: 'Globoplay', enabled: false }),
      makeShortcut(3, { package: 'com.netflix.ninja', tvLabel: 'Netflix', enabled: false }),
      makeShortcut(4, { package: 'com.exemplo.agua', tvLabel: 'Água', enabled: false }),
      makeShortcut(5, {
        package: 'com.google.android.youtube.tv',
        tvLabel: 'YouTube',
        enabled: false,
        iconDataUri: pngIcon(96, 96),
      }),
      makeShortcut(6, { package: 'com.disney.disneyplus', tvLabel: 'Disney+', enabled: false }),
      makeShortcut(7, {
        package: 'com.wbd.stream',
        tvLabel: 'Max',
        installed: false,
        enabled: false,
      }),
    ];

    /** Monta a fileira de novo com a faixa medindo `widthOfStrip` (o jsdom não faz layout: a medida vem do dublê). */
    const mount = (shortcuts: TvShortcut[] = [], guest = false, list: TvShortcut[] = tvApps()) => {
      TestBed.resetTestingModule();
      store = createFakeTvStore();
      store.shortcuts.set(list);
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

    it('offers only the apps installed on the TV, well-known brands first, as many as fit', () => {
      mount();
      expect(suggestionNames()).toEqual([
        'Sugestão: YouTube',
        'Sugestão: Netflix',
        'Sugestão: Disney+',
        'Sugestão: Globoplay',
        'Sugestão: Água',
      ]);
      // Max saiu da TV: nunca é sugerido.
      expect(suggestionNames()).not.toContain('Sugestão: Max');
      expect(root.querySelector('.hint')).toBeNull();
    });

    it('shows the icon the TV sent for the app', () => {
      mount();
      expect(suggestions()[0]!.querySelector('app-tv-app-icon img')).not.toBeNull();
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

    it('never offers more than the TV has installed, however wide the strip is', () => {
      widthOfStrip = 900;
      mount();
      expect(suggestions()).toHaveLength(6);
    });

    it('looks like a suggestion, not like a shortcut: a labelled button that opens a dialog', () => {
      mount();
      const first = suggestions()[0]!;
      expect(first.getAttribute('aria-haspopup')).toBe('dialog');
      expect(first.getAttribute('title')).toBe('Sugestão: YouTube');
      expect(root.querySelector('ul.shortcuts')!.getAttribute('aria-label')).toBe(
        'Sugestões de atalhos',
      );
      expect(tiles().filter((el) => !el.classList.contains('suggestion'))).toHaveLength(0);
    });

    it('tells the screen which installed app and which button was tapped', () => {
      mount();
      const requests: TvSuggestionRequest[] = [];
      fixture.componentInstance.suggest.subscribe((request) => requests.push(request));
      suggestions()[1]!.click();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.app.id).toBe('s3');
      expect(requests[0]!.opener).toBe(suggestions()[1]);
    });

    it('does not offer an app the person removed, and fills its place with the next one', () => {
      mount();
      TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['com.netflix.ninja'] });
      fixture.detectChanges();
      expect(suggestionNames()).toEqual([
        'Sugestão: YouTube',
        'Sugestão: Disney+',
        'Sugestão: Globoplay',
        'Sugestão: Água',
        'Sugestão: Zebra',
      ]);
    });

    it('falls back to the hint once every suggestion was removed, and when nothing can be measured', () => {
      mount();
      TestBed.inject(TvPrefs).set({
        dismissedSuggestions: tvApps().map((app) => app.package),
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

    it('says why there is nothing to suggest when the computer has no ADB, instead of fake suggestions', () => {
      mount([], false, []);
      store.tvs.set([
        {
          id: 'tv1',
          name: 'Sala',
          isDefault: true,
          agentSlug: null,
          kind: 'android',
          online: true,
          capabilities: ['tv.kind.android'],
        },
      ]);
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(0);
      const why = root.querySelector('app-tv-apps-unavailable')!;
      expect(why.textContent).toContain('ele instala o ADB sozinho');
      why.querySelector<HTMLButtonElement>('button')!.click();
      expect(store.refresh).toHaveBeenCalledTimes(1);
    });

    it('gives way to the real shortcuts, with the picker tile while some app is still out of the control', () => {
      const list = tvApps();
      list[4] = { ...list[4]!, enabled: true };
      mount([list[4]!], false, list);
      expect(suggestions()).toHaveLength(0);
      expect(names()).toEqual(['YouTube', 'Escolher apps para o controle']);
      const add = root.querySelector<HTMLButtonElement>('.shortcut.add')!;
      expect(add.getAttribute('aria-haspopup')).toBe('dialog');
      const requests: TvPickRequest[] = [];
      fixture.componentInstance.pick.subscribe((request) => requests.push(request));
      add.click();
      expect(requests).toEqual([{ replacing: null, opener: add }]);
    });

    it('waits while the list has not arrived', () => {
      mount([], false, []);
      store.shortcuts.set(null);
      fixture.detectChanges();
      expect(suggestions()).toHaveLength(0);
      expect(root.querySelector('.hint')).toBeNull();
    });
  });

  it('marks the tiles with a quiet sign while the TV asks for the ADB permission, and keeps them tappable', () => {
    TestBed.inject(TvAdbPermission).needs.set(true);
    fixture.detectChanges();
    expect(tiles().every((el) => el.classList.contains('needs-permission'))).toBe(true);
    expect(names()).toEqual(['Atalho 1, precisa de permissão', 'Sala, precisa de permissão']);
    expect(tiles().some((el) => el.getAttribute('aria-disabled') === 'true')).toBe(false);
    tiles()[0]!.click();
    expect(opened).toHaveBeenCalledTimes(1);
    TestBed.inject(TvAdbPermission).needs.set(false);
    fixture.detectChanges();
    expect(tiles().some((el) => el.classList.contains('needs-permission'))).toBe(false);
    expect(names()).toEqual(['Atalho 1', 'Sala']);
  });
});
