import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { AppsPanel } from './apps-panel';

describe('AppsPanel', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<AppsPanel>>;
  let root: HTMLElement;
  let done: ReturnType<typeof vi.fn<() => void>>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const byLabel = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  /** O botão de abrir tem o texto da linha como nome (nome e pacote), e é o `n`-ésimo da lista. */
  const launcher = (n: number) => root.querySelectorAll<HTMLButtonElement>('.launch')[n - 1];
  const names = () => [...root.querySelectorAll('.item .name')].map((el) => el.textContent?.trim());
  const buttonByText = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const search = (text: string) => {
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  const create = async () => {
    fixture = TestBed.createComponent(AppsPanel);
    root = fixture.nativeElement;
    done = vi.fn<() => void>();
    fixture.componentInstance.done.subscribe(done);
    await render();
  };

  beforeEach(async () => {
    localStorage.clear();
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    await create();
  });

  it('lists every shortcut, named "Atalho n" by default, with the package as small text', () => {
    expect(names()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    expect([...root.querySelectorAll('.package')].map((el) => el.textContent)).toEqual([
      'pacote.app1',
      'pacote.app2',
      'pacote.app3',
    ]);
  });

  it('names an app by the owner name, then by the name the agent publishes, then "Atalho n" (grid and list)', async () => {
    store.shortcuts.set([
      makeShortcut(1, { customLabel: 'Sala', tvLabel: 'YouTube' }),
      makeShortcut(2, { tvLabel: 'Spotify' }),
      makeShortcut(3),
    ]);
    await render();
    expect(names()).toEqual(['Sala', 'Spotify', 'Atalho 3']);
    expect(byLabel('Renomear Spotify')).not.toBeNull();
    expect(byLabel('Ocultar Spotify')).not.toBeNull();
    root.querySelectorAll<HTMLButtonElement>('.seg button')[1].click();
    await render();
    expect(names()).toEqual(['Sala', 'Spotify', 'Atalho 3']);
  });

  it('a renamed app with the name cleared goes back to the name the agent publishes', async () => {
    store.shortcuts.set([makeShortcut(1, { tvLabel: 'Spotify' })]);
    await render();
    byLabel('Renomear Spotify').click();
    await render();
    expect(root.querySelector<HTMLInputElement>('.edit input')!.value).toBe('');
  });

  it('shows the owner name instead of "Atalho n"', async () => {
    store.shortcuts.set([makeShortcut(1, { customLabel: 'Sala' })]);
    await render();
    expect(names()).toEqual(['Sala']);
  });

  it('opens an app on the TV and then asks to close the panel', async () => {
    launcher(2).click();
    await render();
    expect(store.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open when the app could not be opened (the error shows in the panel)', async () => {
    store.launch.mockResolvedValueOnce(false);
    launcher(1).click();
    await render();
    expect(done).not.toHaveBeenCalled();
  });

  it('shows hidden apps dimmed, unable to open, with a "Mostrar" tool', async () => {
    store.shortcuts.set([makeShortcut(1, { enabled: false })]);
    await render();
    expect(root.querySelector('.item')?.classList.contains('off')).toBe(true);
    expect(launcher(1).disabled).toBe(true);
    expect(byLabel('Mostrar Atalho 1')).not.toBeNull();
  });

  it('cannot open anything while the remote cannot send', async () => {
    store.canSend.set(false);
    await render();
    expect(launcher(1).disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.refresh')!.disabled).toBe(true);
  });

  describe('icons', () => {
    const tiles = () => [...root.querySelectorAll<HTMLElement>('.launch app-tv-app-icon')];

    beforeEach(async () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'CineVS', iconDataUri: pngIcon(320, 180) }),
        makeShortcut(2, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }),
        makeShortcut(3, { customLabel: 'Sala' }),
        makeShortcut(4),
      ]);
      await render();
    });

    it('shows each app with its icon, a banner on a wider tile, and a tile with the initial where there is none', () => {
      expect(tiles()).toHaveLength(4);
      expect(tiles().map((tile) => tile.querySelectorAll('img').length)).toEqual([1, 1, 0, 0]);
      expect(tiles().map((tile) => tile.classList.contains('wide'))).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(
        tiles()
          .slice(2)
          .map((tile) => tile.querySelector('.fallback')?.textContent?.trim()),
      ).toEqual(['S', '4']);
    });

    it('keeps the icons out of the names: the button is still named by the text, the pictures are decorative', () => {
      expect(names()).toEqual(['CineVS', 'Spotify', 'Sala', 'Atalho 4']);
      for (const image of root.querySelectorAll('.launch img')) {
        expect(image.getAttribute('alt')).toBe('');
      }
      for (const tile of root.querySelectorAll('.launch .fallback')) {
        expect(tile.getAttribute('aria-hidden')).toBe('true');
      }
    });

    it('loads the pictures late, so a long list does not hold up the scroll', () => {
      for (const image of root.querySelectorAll('.launch img')) {
        expect(image.getAttribute('loading')).toBe('lazy');
        expect(image.getAttribute('decoding')).toBe('async');
      }
    });

    it('shows the same icons in the list, in the same order', async () => {
      buttonByText('Lista').click();
      await render();
      expect(root.querySelector('.list')!.getAttribute('data-view')).toBe('list');
      expect(tiles().map((tile) => tile.querySelectorAll('img').length)).toEqual([1, 1, 0, 0]);
      expect(names()).toEqual(['CineVS', 'Spotify', 'Sala', 'Atalho 4']);
    });

    it('opens the app when the icon is tapped', async () => {
      root.querySelector<HTMLElement>('.launch img')!.click();
      await render();
      expect(store.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });

    it('finds an app by its name and keeps its icon in the filtered list', async () => {
      search('spot');
      await render();
      expect(names()).toEqual(['Spotify']);
      expect(tiles()).toHaveLength(1);
      expect(tiles()[0].querySelector('img')).not.toBeNull();
    });

    it('dims the icon of a hidden app along with its name', async () => {
      store.shortcuts.set([makeShortcut(1, { tvLabel: 'Spotify', enabled: false })]);
      await render();
      expect(root.querySelector('.item')?.classList.contains('off')).toBe(true);
      expect(tiles()).toHaveLength(1);
    });

    it('shows the icon and the current name above the field while renaming', async () => {
      byLabel('Renomear Spotify').click();
      await render();
      const head = root.querySelector('.edit .edit-head')!;
      expect(head.querySelector('app-tv-app-icon img')).not.toBeNull();
      expect(head.querySelector('.edit-name')?.textContent?.trim()).toBe('Spotify');
      expect(head.querySelector('.edit-package')?.textContent?.trim()).toBe('pacote.app2');
      expect(root.querySelector('label')?.textContent?.trim()).toBe('Nome do atalho');
      expect(names()).toEqual(['CineVS', 'Sala', 'Atalho 4']);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      store.shortcuts.set([
        makeShortcut(1, { customLabel: 'Câmera da sala', package: 'com.exemplo.camera' }),
        makeShortcut(2, { tvLabel: 'Filmes e séries', package: 'com.exemplo.video' }),
        makeShortcut(3, { package: 'com.exemplo.jogos' }),
      ]);
      await render();
    });

    it('has a labelled search field', () => {
      const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(input.getAttribute('aria-label')).toBe('Buscar app');
    });

    it('filters by the shown name, ignoring case and accents', async () => {
      search('CAMERA');
      await render();
      expect(names()).toEqual(['Câmera da sala']);
    });

    it('finds by the name the agent published (which is the shown name) and by the package', async () => {
      search('séries');
      await render();
      expect(names()).toEqual(['Filmes e séries']);
      search('video');
      await render();
      expect(names()).toEqual(['Filmes e séries']);
      search('jogos');
      await render();
      expect(names()).toEqual(['Atalho 3']);
    });

    it('shows a friendly line when nothing matches, and the whole list again when cleared', async () => {
      search('zzz');
      await render();
      expect(root.querySelector('.list')).toBeNull();
      expect(root.textContent).toContain('Nenhum app encontrado para essa busca.');
      search('');
      await render();
      expect(names()).toHaveLength(3);
    });

    it('ignores spaces around the search', async () => {
      search('  camera  ');
      await render();
      expect(names()).toEqual(['Câmera da sala']);
    });
  });

  describe('grid and list', () => {
    const list = () => root.querySelector<HTMLElement>('.list')!;
    const pressed = () =>
      [...root.querySelectorAll('.seg button')].map((b) => b.getAttribute('aria-pressed'));

    it('starts as a grid, and the buttons tell which one is on', () => {
      expect(list().getAttribute('data-view')).toBe('grid');
      expect(pressed()).toEqual(['true', 'false']);
    });

    it('switches to a list and remembers the choice for next time', async () => {
      buttonByText('Lista').click();
      await render();
      expect(list().getAttribute('data-view')).toBe('list');
      expect(pressed()).toEqual(['false', 'true']);
      expect(localStorage.getItem('uniover.tv.apps-view')).toBe('list');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
      await create();
      expect(list().getAttribute('data-view')).toBe('list');

      buttonByText('Grade').click();
      await render();
      expect(list().getAttribute('data-view')).toBe('grid');
    });

    it('still works when the browser has no storage', async () => {
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('sem armazenamento');
      });
      buttonByText('Lista').click();
      await render();
      expect(list().getAttribute('data-view')).toBe('list');
      set.mockRestore();
    });
  });

  describe('rename', () => {
    const startRename = async (label = 'Renomear Atalho 2') => {
      byLabel(label).click();
      await render();
    };
    const type = (text: string) => {
      const input = root.querySelector<HTMLInputElement>('.edit input')!;
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };
    const submit = async () => {
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await render();
    };

    it('opens a field with the current own name and a limit of 40 characters', async () => {
      store.shortcuts.set([makeShortcut(1, { customLabel: 'Sala' })]);
      await render();
      await startRename('Renomear Sala');
      const input = root.querySelector<HTMLInputElement>('.edit input')!;
      expect(input.value).toBe('Sala');
      expect(input.getAttribute('maxlength')).toBe('40');
      expect(root.querySelector('label')?.textContent?.trim()).toBe('Nome do atalho');
    });

    it('saves the trimmed name and closes the field', async () => {
      await startRename();
      type('  Sala  ');
      await submit();
      expect(store.renameShortcut).toHaveBeenCalledWith('s2', 'Sala');
      expect(root.querySelector('form')).toBeNull();
    });

    it('an empty name goes back to the default one', async () => {
      await startRename();
      type('');
      await submit();
      expect(store.renameShortcut).toHaveBeenCalledWith('s2', '');
    });

    it('keeps the field open when saving fails', async () => {
      store.renameShortcut.mockResolvedValueOnce(false);
      await startRename();
      type('Sala');
      await submit();
      expect(root.querySelector('form')).not.toBeNull();
    });

    it('Cancelar closes the field without saving', async () => {
      await startRename();
      root.querySelector<HTMLButtonElement>('.edit .secondary')!.click();
      await render();
      expect(root.querySelector('form')).toBeNull();
      expect(store.renameShortcut).not.toHaveBeenCalled();
    });

    it('the field takes the whole row, in the grid too', async () => {
      await startRename();
      expect(root.querySelector('.item.editing')).not.toBeNull();
    });
  });

  it('hides and shows a shortcut', async () => {
    byLabel('Ocultar Atalho 3').click();
    await render();
    expect(store.setShortcutEnabled).toHaveBeenCalledWith('s3', false);

    store.shortcuts.set([makeShortcut(3, { enabled: false })]);
    await render();
    byLabel('Mostrar Atalho 3').click();
    await render();
    expect(store.setShortcutEnabled).toHaveBeenCalledWith('s3', true);
  });

  it('refreshes the list on request, showing "Buscando…" while it works', async () => {
    let finish!: (ok: boolean) => void;
    store.refreshShortcuts.mockReturnValueOnce(
      new Promise<boolean>((resolve) => (finish = resolve)),
    );
    root.querySelector<HTMLButtonElement>('.refresh')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.refresh')?.textContent?.trim()).toBe('Buscando…');
    expect(root.querySelector<HTMLButtonElement>('.refresh')!.disabled).toBe(true);
    finish(true);
    await render();
    expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.refresh')?.textContent?.trim()).toBe('Atualizar lista');
  });

  describe('empty state', () => {
    beforeEach(async () => {
      store.shortcuts.set([]);
      await render();
    });

    it('is friendly: no error, no search, no list, just what is missing and one button', () => {
      expect(root.querySelector('.empty-title')?.textContent?.trim()).toBe(
        'Ainda não temos a lista de apps da TV',
      );
      expect(buttonByText('Buscar apps da TV')).toBeDefined();
      expect(root.querySelector('.list, input[type="search"], [role="alert"]')).toBeNull();
      expect(root.textContent).not.toMatch(/sem atalhos|nenhum atalho/i);
    });

    it('the button asks the TV for the list, showing progress and then a quiet note if it stays empty', async () => {
      let finish!: (ok: boolean) => void;
      store.refreshShortcuts.mockReturnValueOnce(
        new Promise<boolean>((resolve) => (finish = resolve)),
      );
      buttonByText('Buscar apps da TV').click();
      fixture.detectChanges();
      const working = buttonByText('Buscando apps…');
      expect(working.disabled).toBe(true);
      finish(true);
      await render();
      expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(root.textContent).toContain('A TV ainda não informou nenhum app.');
      expect(buttonByText('Buscar apps da TV').disabled).toBe(false);
    });

    it('a failed request shows no note of its own (the panel shows the error) and can be tried again', async () => {
      store.refreshShortcuts.mockResolvedValueOnce(false);
      buttonByText('Buscar apps da TV').click();
      await render();
      expect(root.textContent).not.toContain('A TV ainda não informou');
      expect(buttonByText('Buscar apps da TV').disabled).toBe(false);
    });

    it('is disabled with the reason while the remote cannot send', async () => {
      store.canSend.set(false);
      store.disabledReason.set(
        'O agente da TV está desligado, então os botões não funcionam agora.',
      );
      await render();
      expect(buttonByText('Buscar apps da TV').disabled).toBe(true);
      expect(root.textContent).toContain('agente da TV está desligado');
    });

    it('turns into the list as soon as the apps arrive', async () => {
      store.shortcuts.set([makeShortcut(1)]);
      await render();
      expect(root.querySelector('.empty')).toBeNull();
      expect(names()).toEqual(['Atalho 1']);
    });
  });

  it('says it is loading before the first list arrives', async () => {
    store.shortcuts.set(null);
    await render();
    expect(root.textContent).toContain('Carregando os apps');
    expect(root.querySelector('.empty')).toBeNull();
  });

  it('never offers "ligar e abrir", a timer, voice or a switch to the PC', () => {
    const text = (root.textContent ?? '').toLowerCase();
    expect(text).not.toContain('ligar e abrir');
    expect(text).not.toContain('30 min');
    expect(text).not.toContain('voz');
  });
});

describe('AppsPanel for a guest', () => {
  afterEach(() => localStorage.clear());

  it('opens apps and refreshes the list, but offers neither rename nor hide (owner only)', async () => {
    localStorage.clear();
    const store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
    });
    const fixture = TestBed.createComponent(AppsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.launch')).toHaveLength(3);
    expect(root.querySelector('.tools')).toBeNull();
    expect(root.querySelector('button[aria-label^="Renomear"]')).toBeNull();
    expect(root.querySelector('button[aria-label^="Ocultar"]')).toBeNull();
    expect(root.querySelector('button.refresh')).not.toBeNull();
  });
});
