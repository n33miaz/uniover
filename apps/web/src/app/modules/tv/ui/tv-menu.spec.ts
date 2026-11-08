import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvSelection } from '../data/tv-selection';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
import { TvMenu, TvMenuChoice } from './tv-menu';

describe('TvMenu', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TvMenu>>;
  let root: HTMLElement;
  let chosen: TvMenuChoice[];

  const GUEST_TV = ['module:tv', 'tv:control', 'tv:launch'];
  const rows = () =>
    [...root.querySelectorAll('.ui-row')].map((row) =>
      row.querySelector('.ui-row-title')?.textContent?.trim(),
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
    fixture.componentRef.setInput('appsLabel', 'Apps da TV');
    chosen = [];
    fixture.componentInstance.choose.subscribe((choice) => chosen.push(choice));
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('gathers apps and customization for the person, and, apart, the one thing that affects everybody', () => {
    mount();
    expect(rows()).toEqual([
      'Apps da TV',
      'Mais botões',
      'Personalizar',
      'Entradas',
      'Se a internet cair',
      'Gerenciar TVs',
      'Ajuda para Configurar',
    ]);
    expect(root.querySelectorAll('.ui-group')).toHaveLength(3);
    const bind = root.querySelector<HTMLAnchorElement>('a[href="/ajustes/sistema"]')!;
    expect(bind.getAttribute('href')).toBe('/ajustes/sistema');
    expect(bind.querySelector('.ui-chip')?.textContent?.trim()).toBe('Afeta todos');
    expect(root.querySelector('a[href="/tv/configurar"]')).not.toBeNull();
  });

  it('asks the screen to open Apps, More buttons or Customize, and leaves the closing to the screen', () => {
    mount();
    const [apps, keys, customize] = [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')];
    apps!.click();
    keys!.click();
    customize!.click();
    expect(chosen).toEqual(['apps', 'keys', 'customize']);
    expect(customize!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(keys!.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('has no "Mais botões" row when every key the TV has is already on the main screen', () => {
    mount();
    // Uma Android com a grade cheia e só a Fonte declarada: a Fonte ainda cabe em Mais botões.
    expect(rows()).toContain('Mais botões');
    // Uma Samsung de agente antigo só tem a Fonte, e ela já fecha a fileira da tela principal.
    TestBed.inject(TvSelection).setTvs([
      makeTv('tv', {
        isDefault: true,
        kind: 'samsung',
        capabilities: ['tv.remote', 'tv.kind.samsung'],
      }),
    ]);
    fixture.detectChanges();
    expect(rows()).not.toContain('Mais botões');
  });

  it('names the Apps row as the panel it opens, so it reads "Opções da TV" for who only controls', () => {
    mount();
    fixture.componentRef.setInput('appsLabel', 'Opções da TV');
    fixture.detectChanges();
    expect(rows()[0]).toBe('Opções da TV');
  });

  it('says "Configurar TV" while no computer controls the TV', () => {
    mount();
    store.status.set('unconfigured');
    fixture.detectChanges();
    expect(rows().at(-1)).toBe('Configurar TV');
    expect(root.querySelectorAll('a[href="/tv/configurar"]')).toHaveLength(1);
  });

  it('never shows the guest what changes the TV for everybody', () => {
    mount(GUEST_TV);
    expect(rows()).toEqual([
      'Apps da TV',
      'Mais botões',
      'Personalizar',
      'Entradas',
      'Se a internet cair',
    ]);
    expect(root.querySelector('a[href="/ajustes/sistema"]')).toBeNull();
    expect(root.querySelector('a[href="/tv/configurar"]')).toBeNull();
    expect(root.querySelector('.ui-chip')).toBeNull();
  });

  it('drops the rows the guest has no permission for, and the group that would be left empty', () => {
    mount(['module:tv']);
    expect(rows()).toEqual([]);
    expect(root.querySelector('.ui-group')).toBeNull();
  });

  describe('actions on the TV itself', () => {
    const ANDROID_WITH_SETTINGS = ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.settings.open.v1'];
    const button = (title: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')].find(
        (row) => row.querySelector('.ui-row-title')?.textContent?.trim() === title,
      );

    it('offers Rede and Configurações only where the agent declares it, and always Entradas to who controls', () => {
      mount();
      expect(rows()).not.toContain('Rede');
      expect(rows()).not.toContain('Configurações');
      expect(rows()).toContain('Entradas');
      TestBed.inject(TvSelection).setTvs([
        makeTv('tv', { isDefault: true, capabilities: ANDROID_WITH_SETTINGS }),
      ]);
      fixture.detectChanges();
      expect(rows().slice(0, 6)).toEqual([
        'Apps da TV',
        'Mais botões',
        'Personalizar',
        'Rede',
        'Configurações',
        'Entradas',
      ]);
    });

    it('hides Rede and Configurações on a Samsung, which has no way to open them', () => {
      mount();
      TestBed.inject(TvSelection).setTvs([
        makeTv('tv', {
          isDefault: true,
          kind: 'samsung',
          capabilities: ['tv.remote', 'tv.kind.samsung', 'tv.key.INPUT'],
        }),
      ]);
      fixture.detectChanges();
      expect(rows()).not.toContain('Rede');
      expect(rows()).not.toContain('Configurações');
      expect(rows()).toContain('Entradas');
    });

    it('asks the screen to run each action, and the screen closes the menu first', () => {
      mount();
      TestBed.inject(TvSelection).setTvs([
        makeTv('tv', { isDefault: true, capabilities: ANDROID_WITH_SETTINGS }),
      ]);
      fixture.detectChanges();
      button('Rede')!.click();
      button('Configurações')!.click();
      button('Entradas')!.click();
      expect(chosen).toEqual(['network', 'settings', 'inputs']);
    });

    it('never sends anything just by being shown: nothing runs until the tap', () => {
      mount();
      TestBed.inject(TvSelection).setTvs([
        makeTv('tv', { isDefault: true, capabilities: ANDROID_WITH_SETTINGS }),
      ]);
      fixture.detectChanges();
      expect(chosen).toEqual([]);
      expect(store.openSettings).not.toHaveBeenCalled();
      expect(store.sendKey).not.toHaveBeenCalled();
    });

    it('links to the guide for when the internet falls', () => {
      mount();
      const link = root.querySelector<HTMLAnchorElement>('a[href="/tv/internet"]')!;
      expect(link.querySelector('.ui-row-title')?.textContent?.trim()).toBe('Se a internet cair');
    });
  });

  it('brings back the removed suggestions only for who edits shortcuts, and only when there is one to bring back', () => {
    mount();
    expect(rows()).not.toContain('Mostrar sugestões de atalhos');
    TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['netflix', 'max'] });
    fixture.detectChanges();
    const restore = [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')].find((row) =>
      row.textContent?.includes('Mostrar sugestões de atalhos'),
    )!;
    expect(restore).toBeDefined();
    restore.click();
    fixture.detectChanges();
    expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual([]);
    expect(rows()).not.toContain('Mostrar sugestões de atalhos');
  });
});
