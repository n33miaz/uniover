import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvSelection } from '../data/tv-selection';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
import { TvIcon, TvIconName } from './tv-icon';
import { TvMenu, TvMenuChoice } from './tv-menu';

describe('TvMenu', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TvMenu>>;
  let root: HTMLElement;
  let chosen: TvMenuChoice[];

  const GUEST_TV = ['module:tv', 'tv:control', 'tv:launch'];
  const ANDROID_WITH_SETTINGS = [
    'tv.remote',
    'tv.kind.android',
    'tv.adb',
    'tv.settings.open.v1',
    'tv.key.INPUT',
  ];
  /** Todas as linhas e botões do menu, na ordem da tela. */
  const rows = () =>
    [...root.querySelectorAll('.ui-row .ui-row-title, .tile span')].map((node) =>
      node.textContent?.trim(),
    );
  const tiles = () => [...root.querySelectorAll('.tile')].map((tile) => tile.textContent?.trim());
  const headings = () => [...root.querySelectorAll('h3')].map((heading) => heading.textContent);
  const control = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button.ui-row, button.tile')].find(
      (button) => button.textContent?.trim() === label,
    );

  const mount = (guest: readonly string[] | null = null) => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    if (guest) {
      TestBed.inject(SessionState).setUser({
        id: 'g',
        email: 'g@example.com',
        displayName: 'Gi',
        role: 'guest',
        permissions: [...guest],
      });
    }
    fixture = TestBed.createComponent(TvMenu);
    chosen = [];
    fixture.componentInstance.choose.subscribe((choice) => chosen.push(choice));
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  const useTv = (capabilities: string[], overrides = {}) => {
    TestBed.inject(TvSelection).setTvs([
      makeTv('tv', { isDefault: true, capabilities, ...overrides }),
    ]);
    fixture.detectChanges();
  };

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('gathers the control, the actions on the TV, what is for everybody and the help, in four blocks', () => {
    mount();
    expect(rows()).toEqual([
      'Apps da TV',
      'Mais botões',
      'Personalizar',
      'Limpar',
      'Gerenciar TVs',
      'Ajuda',
    ]);
    expect(headings()).toEqual(['Na TV', 'Para todos']);
    // O título do grupo diz que afeta todos, uma vez só: nenhuma linha repete o aviso.
    expect(root.textContent).not.toContain('Afeta todos');
    expect(root.querySelector('.ui-chip')).toBeNull();
    const bind = root.querySelector<HTMLAnchorElement>('a[href="/ajustes/sistema"]')!;
    expect(bind.querySelector('.ui-row-title')?.textContent?.trim()).toBe('Gerenciar TVs');
  });

  it('asks the screen to open Apps, More buttons, Customize, the cleaning or the help, and leaves the closing to the screen', () => {
    mount();
    useTv(['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.key.INPUT', 'tv.key.GUIDE']);
    // Dois guias (a internet e configurar): a linha Ajuda abre a folha que os lista.
    control('Apps da TV')!.click();
    control('Mais botões')!.click();
    control('Personalizar')!.click();
    control('Limpar')!.click();
    control('Ajuda')!.click();
    expect(chosen).toEqual(['apps', 'keys', 'customize', 'cleanup', 'help']);
    for (const label of ['Mais botões', 'Personalizar', 'Limpar', 'Ajuda']) {
      expect(control(label)!.getAttribute('aria-haspopup'), label).toBe('dialog');
    }
  });

  it('has no "Mais botões" row when every key the TV has is already on the main screen', () => {
    mount();
    // Uma Android com a grade cheia e só as Entradas declaradas: ainda cabem em Mais botões.
    expect(rows()).toContain('Mais botões');
    // Uma Samsung de agente antigo só tem as Entradas, e elas já fecham a fileira da tela principal.
    useTv(['tv.remote', 'tv.kind.samsung'], { kind: 'samsung' });
    expect(rows()).not.toContain('Mais botões');
  });

  it('has a fixed name for the Apps row', () => {
    mount();
    expect(rows()[0]).toBe('Apps da TV');
  });

  it('has no Apps row, and no panel of options in its place, for who only controls', () => {
    mount(['module:tv', 'tv:control']);
    expect(rows()).not.toContain('Apps da TV');
    expect(rows()).not.toContain('Opções da TV');
    expect(rows()).toContain('Limpar');
  });

  it('says "Configurar TV" while no computer controls the TV, and has no setup guide to point to', () => {
    mount();
    store.status.set('unconfigured');
    fixture.detectChanges();
    expect(rows()).toContain('Configurar TV');
    expect(root.querySelectorAll('a[href="/tv/configurar"]')).toHaveLength(1);
    // Só resta o guia da internet: a linha Ajuda leva direto a ele.
    expect(root.querySelector('a[href="/tv/internet"] .ui-row-title')?.textContent?.trim()).toBe(
      'Ajuda',
    );
  });

  it('never shows the guest what changes the TV for everybody', () => {
    mount(GUEST_TV);
    expect(rows()).toEqual(['Apps da TV', 'Mais botões', 'Personalizar', 'Limpar', 'Ajuda']);
    expect(headings()).toEqual(['Na TV']);
    expect(root.querySelector('a[href="/ajustes/sistema"]')).toBeNull();
    expect(root.querySelector('a[href="/tv/configurar"]')).toBeNull();
  });

  it('drops the rows the guest has no permission for, and the group that would be left empty', () => {
    mount(['module:tv']);
    expect(rows()).toEqual([]);
    expect(root.querySelector('.ui-group')).toBeNull();
    expect(root.querySelector('.on-tv')).toBeNull();
  });

  describe('the actions on the TV', () => {
    it('are side by side in their own block, named for what they open on the TV', () => {
      mount();
      useTv(ANDROID_WITH_SETTINGS);
      expect(tiles()).toEqual(['Limpar', 'Entradas', 'Wi-Fi da TV', 'Configurações da TV']);
      expect(root.querySelectorAll('.on-tv button.tile')).toHaveLength(4);
      expect(root.querySelector('.on-tv')?.getAttribute('aria-labelledby')).toBe('tv-menu-on-tv');
    });

    it('offers Wi-Fi and Configurações only where the agent declares them, and Entradas only with the INPUT key', () => {
      mount();
      expect(tiles()).toEqual(['Limpar']);
      useTv(['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.settings.open.v1']);
      expect(tiles()).toEqual(['Limpar', 'Wi-Fi da TV', 'Configurações da TV']);
    });

    it('hides the cleaning, Wi-Fi and Configurações on a Samsung, which keeps only Entradas', () => {
      mount();
      useTv(['tv.remote', 'tv.kind.samsung', 'tv.key.INPUT'], { kind: 'samsung' });
      expect(tiles()).toEqual(['Entradas']);
    });

    it('has no block at all when nothing is left to do on the TV', () => {
      mount();
      useTv(['tv.remote', 'tv.kind.samsung'], { kind: 'samsung' });
      expect(root.querySelector('.on-tv')).toBeNull();
      expect(headings()).not.toContain('Na TV');
    });

    it('asks the screen to run each action, and the screen closes the menu first', () => {
      mount();
      useTv(ANDROID_WITH_SETTINGS);
      control('Wi-Fi da TV')!.click();
      control('Configurações da TV')!.click();
      control('Entradas')!.click();
      expect(chosen).toEqual(['network', 'settings', 'inputs']);
    });

    it('never sends anything just by being shown: nothing runs until the tap', () => {
      mount();
      useTv(ANDROID_WITH_SETTINGS);
      expect(chosen).toEqual([]);
      expect(store.openSettings).not.toHaveBeenCalled();
      expect(store.sendKey).not.toHaveBeenCalled();
      expect(store.cleanup).not.toHaveBeenCalled();
    });

    it('keeps the cleaning dimmed but reachable without an agent, and a tap does nothing', () => {
      mount();
      store.canSend.set(false);
      fixture.detectChanges();
      const clean = control('Limpar')!;
      expect(clean.disabled).toBe(false);
      expect(clean.getAttribute('aria-disabled')).toBe('true');
      clean.click();
      expect(chosen).toEqual([]);
    });

    it('says "Limpando…" while it works and ignores a second tap', () => {
      mount();
      store.cleaning.set(true);
      fixture.detectChanges();
      const clean = control('Limpando…')!;
      expect(clean.getAttribute('aria-disabled')).toBe('true');
      expect(root.querySelector('app-tv-icon.spin')).not.toBeNull();
      clean.click();
      expect(chosen).toEqual([]);
      store.cleaning.set(false);
      fixture.detectChanges();
      expect(control('Limpar')!.getAttribute('aria-disabled')).toBeNull();
    });

    const iconPath = (name: TvIconName): string => {
      const icon = TestBed.createComponent(TvIcon);
      icon.componentRef.setInput('name', name);
      icon.detectChanges();
      return icon.nativeElement.querySelector('path')?.getAttribute('d') ?? '';
    };
    const drawing = (node: Element | undefined | null) =>
      node?.querySelector('svg path, .ui-tile path')?.getAttribute('d') ?? '';

    it('keeps the wifi drawing for Wi-Fi da TV and gives the help another one, so they are told apart', () => {
      mount();
      useTv(ANDROID_WITH_SETTINGS);
      const wifi = drawing(control('Wi-Fi da TV'));
      const help = drawing(control('Ajuda'));
      expect(wifi).toBe(iconPath('wifi'));
      expect(help).toBe(iconPath('info'));
      expect(help).not.toBe(wifi);
    });
  });

  describe('for everybody', () => {
    it('gives TV Livre the house and Gerenciar TVs the TV, so the rows are told apart without reading', () => {
      mount();
      useTv([...ANDROID_WITH_SETTINGS, 'tv.livre.v1']);
      const livre = root.querySelector<HTMLAnchorElement>('a[href="/tv/livre"]')!;
      const manage = root.querySelector<HTMLAnchorElement>('a[href="/ajustes/sistema"]')!;
      const path = (row: Element) => row.querySelector('.ui-tile path')?.getAttribute('d');
      const render = (name: TvIconName) => {
        const icon = TestBed.createComponent(TvIcon);
        icon.componentRef.setInput('name', name);
        icon.detectChanges();
        return icon.nativeElement.querySelector('path')?.getAttribute('d');
      };
      expect(path(livre)).toBe(render('home'));
      expect(path(manage)).toBe(render('tv'));
      expect(root.querySelectorAll('#tv-menu-for-all ~ .ui-group .ui-row')).toHaveLength(2);
    });
  });

  describe('the help', () => {
    it('opens a sheet from one row when there are two guides', () => {
      mount();
      expect(root.querySelector('a[href="/tv/internet"]')).toBeNull();
      expect(root.querySelector('a[href="/tv/configurar"]')).toBeNull();
      expect(control('Ajuda')).toBeDefined();
    });

    it('goes straight to the only guide there is', () => {
      mount(GUEST_TV);
      expect(control('Ajuda')).toBeUndefined();
      const link = root.querySelector<HTMLAnchorElement>('a[href="/tv/internet"]')!;
      expect(link.querySelector('.ui-row-title')?.textContent?.trim()).toBe('Ajuda');
    });

    it('is not there for an account that controls nothing and administers nothing', () => {
      mount(['module:tv', 'tv:launch']);
      expect(rows()).toEqual(['Apps da TV']);
    });
  });

  describe('the removed suggestions', () => {
    it('come back from Personalizar for who controls, so the menu does not carry the row', () => {
      mount();
      TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['netflix', 'max'] });
      fixture.detectChanges();
      expect(rows()).not.toContain('Mostrar sugestões de atalhos');
    });

    it('come back from the menu only for who edits shortcuts and has no Personalizar, and only when there is one', () => {
      mount(['module:tv', 'tv:edit-shortcuts']);
      expect(rows()).not.toContain('Mostrar sugestões de atalhos');
      TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['netflix', 'max'] });
      fixture.detectChanges();
      const restore = control('Mostrar sugestões de atalhos')!;
      expect(restore).toBeDefined();
      restore.click();
      fixture.detectChanges();
      expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual([]);
      expect(rows()).not.toContain('Mostrar sugestões de atalhos');
    });
  });
});
