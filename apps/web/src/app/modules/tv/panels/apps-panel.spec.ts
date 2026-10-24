import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { withOrder } from '../data/tv-order';
import { TvSelection } from '../data/tv-selection';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeShortcut, makeTv, pngIcon } from '../tv-test-kit';
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
  /** O botão de abrir é o azulejo todo; o `n`-ésimo na ordem da tela. */
  const launcher = (n: number) => root.querySelectorAll<HTMLButtonElement>('.launch')[n - 1];
  const names = () => [...root.querySelectorAll('.item .name')].map((el) => el.textContent?.trim());
  const headings = () => [...root.querySelectorAll('h3')].map((el) => el.textContent?.trim());
  const buttonByText = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const search = (text: string) => {
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const startEditing = async () => {
    buttonByText('Editar').click();
    await render();
  };

  const create = async () => {
    fixture = TestBed.createComponent(AppsPanel);
    root = fixture.nativeElement;
    done = vi.fn<() => void>();
    fixture.componentInstance.done.subscribe(done);
    await render();
  };

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    await create();
  });

  it('lists every app as a tile with the name under the icon, and keeps the package out of sight', () => {
    expect(names()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    expect(root.querySelectorAll('ul.grid li.item')).toHaveLength(3);
    expect(root.querySelectorAll('.package')).toHaveLength(0);
    expect(root.textContent).not.toContain('pacote.app');
    // Nome embaixo do ícone: o azulejo é o botão e tem o nome como nome acessível.
    expect(launcher(1).getAttribute('aria-label')).toBeNull();
    expect(launcher(1).querySelector('.name')?.textContent?.trim()).toBe('Atalho 1');
    expect(launcher(1).querySelector('app-tv-app-icon')).not.toBeNull();
  });

  it('names an app by the owner name, then by the name the agent publishes, then "Atalho n"', async () => {
    store.shortcuts.set([
      makeShortcut(1, { customLabel: 'Sala', tvLabel: 'YouTube' }),
      makeShortcut(2, { tvLabel: 'Spotify' }),
      makeShortcut(3),
    ]);
    await render();
    expect(names()).toEqual(['Sala', 'Spotify', 'Atalho 3']);
    await startEditing();
    expect(names()).toEqual(['Sala', 'Spotify', 'Atalho 3']);
    expect(byLabel('Renomear Spotify')).not.toBeNull();
    expect(byLabel('Tirar Spotify do controle')).not.toBeNull();
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

  it('cannot open anything while the remote cannot send, nor ask for the list', async () => {
    store.canSend.set(false);
    await render();
    expect(launcher(1).disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.refresh')!.disabled).toBe(true);
  });

  describe('the controle and the rest', () => {
    beforeEach(async () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify' }),
        makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
        makeShortcut(3, { tvLabel: 'Netflix' }),
        makeShortcut(4, { tvLabel: 'Jogos', enabled: false }),
      ]);
      await render();
    });

    it('splits the grid in "No controle" (the row at the top of the remote) and "Fora do controle", each app once', () => {
      expect(headings()).toEqual(['No controle', 'Fora do controle']);
      const [pinned, rest] = [...root.querySelectorAll('section.group')].map((section) =>
        [...section.querySelectorAll('.name')].map((el) => el.textContent?.trim()),
      );
      expect(pinned).toEqual(['Spotify', 'Netflix']);
      expect(rest).toEqual(['YouTube', 'Jogos']);
      expect(names()).toHaveLength(4);
    });

    it('shows what is out of the control as plain tiles, and says that a tap opens them and how to pin them', () => {
      expect(root.querySelectorAll('.item.off')).toHaveLength(0);
      expect(root.querySelectorAll<HTMLButtonElement>('.launch:disabled')).toHaveLength(0);
      expect(root.querySelector('#apps-group-rest')!.parentElement!.textContent).toContain(
        'Toque para abrir. Para ter no controle, fixe em Editar.',
      );
    });

    it('opens an app that is out of the control with a tap, like any other', async () => {
      // A ordem da tela é a das seções: Spotify, Netflix (no controle), YouTube, Jogos (fora).
      launcher(4).click();
      await render();
      expect(store.launch).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's4', enabled: false, installed: true }),
      );
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('does not list an app that left the TV: not in the sections, not in the search, not in the edit mode', async () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify' }),
        makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
        makeShortcut(3, { tvLabel: 'Netflix', enabled: false, installed: false }),
      ]);
      await render();
      expect(names()).toEqual(['Spotify', 'YouTube']);
      expect(headings()).toEqual(['No controle', 'Fora do controle']);
      search('netflix');
      await render();
      expect(names()).toEqual([]);
      expect(root.textContent).toContain('Nenhum app encontrado para essa busca.');
      search('');
      await startEditing();
      expect(names()).toEqual(['Spotify', 'YouTube']);
    });

    it('does not show a pinned app that left the TV either', async () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify' }),
        makeShortcut(2, { tvLabel: 'Netflix', enabled: true, installed: false }),
      ]);
      await render();
      expect(names()).toEqual(['Spotify']);
    });

    it('marks nothing in the sections (the heading already says it) and has no "Todos os apps" heading', () => {
      expect(root.querySelectorAll('.mark')).toHaveLength(0);
      expect(headings()).not.toContain('Todos os apps');
    });

    it('with every app in the control there is only the first section', async () => {
      store.shortcuts.set([makeShortcut(1), makeShortcut(2)]);
      await render();
      expect(headings()).toEqual(['No controle']);
    });

    it('with none in the control the owner is told how to pin, and the apps are all in the second section', async () => {
      store.shortcuts.set([
        makeShortcut(1, { enabled: false }),
        makeShortcut(2, { enabled: false }),
      ]);
      await render();
      expect(headings()).toEqual(['No controle', 'Fora do controle']);
      expect(root.textContent).toContain('Nenhum app no controle. Toque em Editar para fixar.');
    });

    it('does not shuffle apps between sections while the owner edits: one list in the original order', async () => {
      await startEditing();
      expect(headings()).toEqual(['Todos os apps']);
      expect(names()).toEqual(['Spotify', 'YouTube', 'Netflix', 'Jogos']);
    });
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

    it('shows each app with its icon on a tile of the same square shape, and a tile with the initial where there is none', () => {
      expect(tiles()).toHaveLength(4);
      expect(tiles().map((tile) => tile.querySelectorAll('img').length)).toEqual([1, 1, 0, 0]);
      expect(tiles().some((tile) => tile.classList.contains('wide'))).toBe(false);
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

    it('does not dim the icon of an app out of the control: it opens like the others', async () => {
      store.shortcuts.set([makeShortcut(1, { tvLabel: 'Spotify', enabled: false })]);
      await render();
      expect(root.querySelector('.item')?.classList.contains('off')).toBe(false);
      expect(tiles()).toHaveLength(1);
      expect(launcher(1).disabled).toBe(false);
    });

    it('shows the icon, the name and the package above the field while renaming', async () => {
      await startEditing();
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
        makeShortcut(3, { package: 'com.exemplo.jogos', enabled: false }),
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

    it('shows one list with no sections, marking the apps that are in the control for the readers too', async () => {
      search('com.exemplo');
      await render();
      expect(headings()).toEqual([]);
      expect(names()).toEqual(['Câmera da sala', 'Filmes e séries', 'Atalho 3']);
      const marked = [...root.querySelectorAll('.item')].map((item) => item.querySelector('.mark'));
      expect(marked.map((mark) => mark !== null)).toEqual([true, true, false]);
      // O nome do botão não muda; a marca chega como descrição.
      const first = launcher(1);
      expect(first.querySelector('.name')?.textContent?.trim()).toBe('Câmera da sala');
      const description = root.querySelector(`#${first.getAttribute('aria-describedby')}`);
      expect(description?.textContent?.trim()).toBe('No controle');
      expect(launcher(3).hasAttribute('aria-describedby')).toBe(false);
    });

    it('goes back to the two sections when the search is cleared', async () => {
      search('camera');
      await render();
      expect(headings()).toEqual([]);
      search('   ');
      await render();
      expect(headings()).toEqual(['No controle', 'Fora do controle']);
    });

    it('shows a friendly line when nothing matches, and the whole list again when cleared', async () => {
      search('zzz');
      await render();
      expect(root.querySelector('.grid')).toBeNull();
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

  describe('edit mode', () => {
    beforeEach(async () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify' }),
        makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
      ]);
      await render();
    });

    it('is a button at the top that turns into "Concluir", and leaving it brings the sections back', async () => {
      expect(root.querySelector('.tools')).toBeNull();
      await startEditing();
      expect(buttonByText('Concluir')).toBeDefined();
      expect(buttonByText('Editar')).toBeUndefined();
      buttonByText('Concluir').click();
      await render();
      expect(root.querySelector('.tools')).toBeNull();
      expect(headings()).toEqual(['No controle', 'Fora do controle']);
    });

    it('shows the pin and rename buttons on every tile, and the package only now', async () => {
      await startEditing();
      expect(root.querySelectorAll('.item .tools')).toHaveLength(2);
      expect([...root.querySelectorAll('.package')].map((el) => el.textContent)).toEqual([
        'pacote.app1',
        'pacote.app2',
      ]);
      expect(byLabel('Tirar Spotify do controle')).not.toBeNull();
      expect(byLabel('Fixar YouTube no controle')).not.toBeNull();
      expect(byLabel('Renomear Spotify')).not.toBeNull();
      expect(byLabel('Renomear YouTube')).not.toBeNull();
    });

    it('marks the tiles that are in the control', async () => {
      await startEditing();
      const marks = [...root.querySelectorAll('.item')].map(
        (item) => !!item.querySelector('.mark'),
      );
      expect(marks).toEqual([true, false]);
      expect(byLabel('Tirar Spotify do controle').classList.contains('on')).toBe(true);
      expect(byLabel('Fixar YouTube no controle').classList.contains('on')).toBe(false);
    });

    it('opens nothing on a tap on the tile: no launch button exists while editing', async () => {
      await startEditing();
      expect(root.querySelectorAll('.launch')).toHaveLength(0);
      root.querySelector<HTMLElement>('.item img, .item .fallback')!.click();
      await render();
      expect(store.launch).not.toHaveBeenCalled();
    });

    it('pins and unpins with the same call as before', async () => {
      await startEditing();
      byLabel('Tirar Spotify do controle').click();
      await render();
      expect(store.setShortcutEnabled).toHaveBeenCalledWith('s1', false);

      byLabel('Fixar YouTube no controle').click();
      await render();
      expect(store.setShortcutEnabled).toHaveBeenCalledWith('s2', true);
    });

    it('ignores a second tap on a pin while the first one is still going, without taking the focus away', async () => {
      let finish!: (ok: boolean) => void;
      store.setShortcutEnabled.mockReturnValueOnce(
        new Promise<boolean>((resolve) => (finish = resolve)),
      );
      await startEditing();
      const pin = byLabel('Tirar Spotify do controle');
      pin.focus();
      pin.click();
      fixture.detectChanges();
      expect(pin.getAttribute('aria-disabled')).toBe('true');
      expect(pin.disabled).toBe(false);
      pin.click();
      expect(store.setShortcutEnabled).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(pin);
      finish(true);
      await render();
      expect(pin.hasAttribute('aria-disabled')).toBe(false);
    });

    it('keeps the apps where they are when one is pinned or unpinned', async () => {
      await startEditing();
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify', enabled: false }),
        makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
      ]);
      await render();
      expect(names()).toEqual(['Spotify', 'YouTube']);
      expect(headings()).toEqual(['Todos os apps']);
    });

    it('can be searched in, and the search keeps the tools', async () => {
      await startEditing();
      search('you');
      await render();
      expect(names()).toEqual(['YouTube']);
      expect(root.querySelectorAll('.tools')).toHaveLength(1);
    });

    it('is not offered when the app list is empty or still loading', async () => {
      store.shortcuts.set([]);
      await render();
      expect(root.querySelector('.edit-toggle')).toBeNull();
      store.shortcuts.set(null);
      await render();
      expect(root.querySelector('.edit-toggle')).toBeNull();
    });
  });

  describe('changing the order of the row (edit mode)', () => {
    /** s1, s3 e s5 estão no controle (a fileira); s2 está fora dele; s4 saiu da TV e o painel nem o mostra. */
    const row = () => [
      makeShortcut(1, { tvLabel: 'Spotify' }),
      makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
      makeShortcut(3, { tvLabel: 'Netflix' }),
      makeShortcut(4, { tvLabel: 'Jogos', enabled: false, installed: false }),
      makeShortcut(5, { tvLabel: 'Disney' }),
    ];
    const mover = (name: string, direction: 'left' | 'right') =>
      byLabel(`Mover ${name} para a ${direction === 'left' ? 'esquerda' : 'direita'}`);
    const said = () => root.querySelector('[data-reorder-status]')!.textContent?.trim();

    beforeEach(async () => {
      store.shortcuts.set(row());
      await render();
    });

    it('has no move buttons outside the edit mode', () => {
      expect(root.querySelectorAll('[data-move]')).toHaveLength(0);
    });

    it('puts the buttons only on the apps in the control, and none on the others', async () => {
      await startEditing();
      expect(root.querySelectorAll('[data-move]')).toHaveLength(6);
      for (const name of ['Spotify', 'Netflix', 'Disney']) {
        expect(mover(name, 'left')).not.toBeNull();
        expect(mover(name, 'right')).not.toBeNull();
      }
      expect(root.querySelector('button[aria-label="Mover YouTube para a esquerda"]')).toBeNull();
      // A lista continua uma só e na ordem de sempre: mudar a ordem da fileira não embaralha a edição.
      expect(headings()).toEqual(['Todos os apps']);
      expect(names()).toEqual(['Spotify', 'YouTube', 'Netflix', 'Disney']);
    });

    it('explains the arrows, once there is more than one app in the row to put in order', async () => {
      await startEditing();
      expect(root.textContent).toContain('Os apps no controle têm setas');

      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify' }),
        makeShortcut(2, { enabled: false }),
      ]);
      await render();
      expect(root.textContent).not.toContain('Os apps no controle têm setas');
    });

    it('sends the whole list, the app that left the TV included, with the app swapped with its neighbour in the control', async () => {
      await startEditing();
      mover('Netflix', 'left').click();
      await render();
      // Netflix troca com o Spotify; YouTube e Jogos (que a fileira não mostra) ficam onde estavam.
      expect(store.reorder).toHaveBeenCalledTimes(1);
      expect(store.reorder).toHaveBeenCalledWith(['s3', 's2', 's1', 's4', 's5']);
    });

    it('shows the new order at once', async () => {
      await startEditing();
      mover('Disney', 'left').click();
      await render();
      expect(names()).toEqual(['Spotify', 'YouTube', 'Disney', 'Netflix']);
      mover('Spotify', 'right').click();
      await render();
      expect(names()).toEqual(['Disney', 'YouTube', 'Spotify', 'Netflix']);
    });

    it('says where the app ended up, counting only the apps of the row, in a polite region of its own', async () => {
      await startEditing();
      const region = root.querySelector('[data-reorder-status]')!;
      expect(region.getAttribute('role')).toBe('status');
      expect(region.getAttribute('aria-live')).toBe('polite');
      // Não é a região do "Buscando…": um aviso não apaga o outro.
      expect(region).not.toBe(root.querySelector('.sr:not([data-reorder-status])'));

      mover('Disney', 'left').click();
      await render();
      expect(said()).toBe('Disney, posição 2 de 3');
      mover('Disney', 'left').click();
      await render();
      expect(said()).toBe('Disney, posição 1 de 3');
    });

    it('keeps the focus on the button the owner used, which follows the app to its new place', async () => {
      await startEditing();
      mover('Disney', 'left').click();
      await render();
      expect(document.activeElement).toBe(mover('Disney', 'left'));
      expect(document.activeElement?.getAttribute('data-for')).toBe('s5');

      mover('Disney', 'right').click();
      await render();
      expect(document.activeElement).toBe(mover('Disney', 'right'));
    });

    it('at the ends the button is only dimmed: the focus stays on it and a tap does nothing', async () => {
      await startEditing();
      mover('Netflix', 'left').click();
      await render();
      const first = mover('Netflix', 'left');
      expect(first.getAttribute('aria-disabled')).toBe('true');
      expect(first.disabled).toBe(false);
      expect(document.activeElement).toBe(first);

      store.reorder.mockClear();
      first.click();
      await render();
      expect(store.reorder).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(first);
      expect(said()).toBe('Netflix, posição 1 de 3');

      // E o último da fileira não vai mais para a direita.
      expect(mover('Disney', 'right').getAttribute('aria-disabled')).toBe('true');
    });

    it('says nothing and moves no focus when the order did not change (no network, for instance)', async () => {
      store.reorder.mockImplementationOnce(async () => false);
      await startEditing();
      mover('Disney', 'left').click();
      await render();
      expect(names()).toEqual(['Spotify', 'YouTube', 'Netflix', 'Disney']);
      expect(said()).toBe('');
    });

    it('drops the "where it ended up" phrase when the server refuses the order (the error notice speaks instead)', async () => {
      let refuse!: (saved: boolean) => void;
      store.reorder.mockImplementationOnce(async (ids) => {
        store.shortcuts.set(withOrder(store.shortcuts() ?? [], ids) ?? []);
        return new Promise<boolean>((resolve) => (refuse = resolve));
      });
      await startEditing();
      mover('Disney', 'left').click();
      await render();
      expect(said()).toBe('Disney, posição 2 de 3');

      refuse(false);
      await new Promise((resolve) => setTimeout(resolve));
      await render();
      expect(said()).toBe('');
    });

    it('names an app with no name of its own by the position it now has ("Atalho n" follows the order)', async () => {
      store.shortcuts.set([makeShortcut(1), makeShortcut(2)]);
      await render();
      await startEditing();
      mover('Atalho 2', 'left').click();
      await render();
      expect(said()).toBe('Atalho 1, posição 1 de 2');
    });

    it('offers no buttons while searching, because the filter hides the neighbours', async () => {
      await startEditing();
      search('netflix');
      await render();
      expect(root.querySelectorAll('[data-move]')).toHaveLength(0);
      expect(root.querySelectorAll('.tools')).toHaveLength(1);
      expect(root.textContent).not.toContain('Os apps no controle têm setas');

      search('');
      await render();
      expect(root.querySelectorAll('[data-move]')).toHaveLength(6);
    });

    it('leaving the edit mode takes the buttons and the last announcement away', async () => {
      await startEditing();
      mover('Disney', 'left').click();
      await render();
      buttonByText('Concluir').click();
      await render();
      expect(root.querySelectorAll('[data-move]')).toHaveLength(0);
      expect(said()).toBe('');
    });

    it('does not open anything or ask the TV for anything when an app is moved', async () => {
      await startEditing();
      mover('Netflix', 'right').click();
      await render();
      expect(store.launch).not.toHaveBeenCalled();
      expect(store.setShortcutEnabled).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    });

    it('works the same with the agent off: it is a list of the screen, not a command to the TV', async () => {
      store.canSend.set(false);
      await startEditing();
      mover('Netflix', 'left').click();
      await render();
      expect(store.reorder).toHaveBeenCalledTimes(1);
    });
  });

  describe('rename', () => {
    const startRename = async (label = 'Renomear Atalho 2') => {
      await startEditing();
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

    it('opens a field with the current own name and a limit of 40 characters, with the focus in it', async () => {
      store.shortcuts.set([makeShortcut(1, { customLabel: 'Sala' })]);
      await render();
      await startRename('Renomear Sala');
      const input = root.querySelector<HTMLInputElement>('.edit input')!;
      expect(input.value).toBe('Sala');
      expect(input.getAttribute('maxlength')).toBe('40');
      expect(root.querySelector('label')?.textContent?.trim()).toBe('Nome do atalho');
      expect(document.activeElement).toBe(input);
    });

    it('starts empty for an app that has no name of its own: the field says to leave it blank for the default', async () => {
      store.shortcuts.set([makeShortcut(1, { tvLabel: 'Spotify' })]);
      await render();
      await startRename('Renomear Spotify');
      expect(root.querySelector<HTMLInputElement>('.edit input')!.value).toBe('');
      expect(root.textContent).toContain('Deixe em branco para voltar ao nome padrão.');
    });

    it('saves the trimmed name, closes the field and gives the focus back to the rename button', async () => {
      await startRename();
      type('  Sala  ');
      await submit();
      expect(store.renameShortcut).toHaveBeenCalledWith('s2', 'Sala');
      expect(root.querySelector('form')).toBeNull();
      expect(document.activeElement).toBe(byLabel('Renomear Atalho 2'));
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

    it('Cancelar closes the field without saving and gives the focus back to the rename button', async () => {
      await startRename();
      root.querySelector<HTMLButtonElement>('.edit .secondary')!.click();
      await render();
      expect(root.querySelector('form')).toBeNull();
      expect(store.renameShortcut).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(byLabel('Renomear Atalho 2'));
    });

    it('the field takes the whole row of the grid', async () => {
      await startRename();
      expect(root.querySelector('.item.editing')).not.toBeNull();
    });

    it('leaving the edit mode drops an open field', async () => {
      await startRename();
      buttonByText('Concluir').click();
      await render();
      expect(root.querySelector('form')).toBeNull();
    });
  });

  describe('cleanup', () => {
    const clean = () => root.querySelector<HTMLButtonElement>('.clean')!;
    const sheet = () => root.querySelector('app-tv-cleanup-sheet dialog');
    const sheetButton = (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('app-tv-cleanup-sheet button')].find(
        (b) => b.textContent?.trim() === name,
      )!;

    it('is a button with an icon only and a name, in the top bar next to the refresh', () => {
      expect(clean().getAttribute('aria-label')).toBe('Limpar a TV');
      expect(clean().textContent?.trim()).toBe('');
      expect(clean().closest('.bar')).toBe(root.querySelector('.refresh')!.closest('.bar'));
      expect(clean().previousElementSibling).toBe(root.querySelector('.refresh'));
      expect(clean().getAttribute('aria-haspopup')).toBe('dialog');
    });

    it('has no cleanup on a TV without the ADB channel (a Samsung), and the app grid stays', async () => {
      TestBed.inject(TvSelection).setTvs([
        makeTv('tv', {
          isDefault: true,
          kind: 'samsung',
          capabilities: ['tv.remote', 'tv.kind.samsung'],
        }),
      ]);
      await render();
      expect(clean()).toBeNull();
      expect(root.querySelectorAll('.launch')).toHaveLength(3);
      expect(root.querySelector('app-tv-cleanup-sheet')).toBeNull();
    });

    it('keeps the cleanup on an Android with ADB', async () => {
      TestBed.inject(TvSelection).setTvs([makeTv('tv', { isDefault: true })]);
      await render();
      expect(clean()).not.toBeNull();
    });

    it('opens the confirmation sheet on a tap, without asking for anything yet', async () => {
      expect(sheet()).toBeNull();
      clean().click();
      await render();
      expect(sheet()?.hasAttribute('open')).toBe(true);
      expect(root.querySelector('app-tv-cleanup-sheet h2')?.textContent).toBe('Limpar a TV?');
      expect(store.cleanup).not.toHaveBeenCalled();
    });

    it('Cancelar closes the sheet, asks for nothing and gives the focus back to the button', async () => {
      clean().click();
      await render();
      sheetButton('Cancelar').click();
      await render();
      expect(sheet()).toBeNull();
      expect(store.cleanup).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(clean());
    });

    it('Limpar asks for the cleanup once and the sheet is gone: the rest of the panel stays free', async () => {
      clean().click();
      await render();
      sheetButton('Limpar').click();
      await render();
      expect(store.cleanup).toHaveBeenCalledTimes(1);
      expect(sheet()).toBeNull();
    });

    it('says "Limpando…" by name and to readers while it works, and ignores a second tap', async () => {
      store.cleaning.set(true);
      await render();
      expect(clean().getAttribute('aria-label')).toBe('Limpando a TV…');
      expect(clean().getAttribute('aria-disabled')).toBe('true');
      expect(root.querySelector('.note.cleaning')?.getAttribute('role')).toBe('status');
      expect(root.querySelector('.note.cleaning')?.textContent).toContain('Limpando a TV…');
      clean().click();
      await render();
      expect(sheet()).toBeNull();

      store.cleaning.set(false);
      await render();
      expect(clean().getAttribute('aria-label')).toBe('Limpar a TV');
      expect(clean().hasAttribute('aria-disabled')).toBe(false);
      expect(root.querySelector('.note.cleaning')).toBeNull();
    });

    it('stays dimmed and focusable without an agent, and a tap does nothing', async () => {
      store.canSend.set(false);
      await render();
      expect(clean().disabled).toBe(false);
      expect(clean().getAttribute('aria-disabled')).toBe('true');
      expect(clean().classList.contains('off')).toBe(true);
      clean().focus();
      expect(document.activeElement).toBe(clean());
      clean().click();
      await render();
      expect(sheet()).toBeNull();
      expect(store.cleanup).not.toHaveBeenCalled();
    });

    it('does not touch the list of apps nor the refresh while it opens', async () => {
      clean().click();
      await render();
      expect(store.refreshShortcuts).not.toHaveBeenCalled();
      expect(names()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    });
  });

  describe('refresh', () => {
    const refresh = () => root.querySelector<HTMLButtonElement>('.refresh')!;

    it('is a button with an icon only and a name, at the top next to the search', () => {
      expect(refresh().getAttribute('aria-label')).toBe('Atualizar lista');
      expect(refresh().textContent?.trim()).toBe('');
      expect(refresh().closest('.bar')!.querySelector('input[type="search"]')).not.toBeNull();
    });

    it('asks for the list, saying "Buscando…" by name and to readers while it works', async () => {
      let finish!: (ok: boolean) => void;
      store.refreshShortcuts.mockReturnValueOnce(
        new Promise<boolean>((resolve) => (finish = resolve)),
      );
      refresh().focus();
      refresh().click();
      fixture.detectChanges();
      expect(refresh().getAttribute('aria-label')).toBe('Buscando…');
      expect(refresh().getAttribute('aria-disabled')).toBe('true');
      expect(root.querySelector('[role="status"].sr')?.textContent?.trim()).toBe('Buscando…');
      // O foco fica no botão durante o pedido.
      expect(document.activeElement).toBe(refresh());

      refresh().click();
      expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);

      finish(true);
      await render();
      expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(refresh().getAttribute('aria-label')).toBe('Atualizar lista');
      expect(refresh().hasAttribute('aria-disabled')).toBe(false);
      expect(root.querySelector('[role="status"].sr')?.textContent?.trim()).toBe('');
    });

    it('can ask again after a failed request', async () => {
      store.refreshShortcuts.mockResolvedValueOnce(false);
      refresh().click();
      await render();
      refresh().click();
      await render();
      expect(store.refreshShortcuts).toHaveBeenCalledTimes(2);
    });
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
      expect(
        root.querySelector('.grid, input[type="search"], .edit-toggle, [role="alert"]'),
      ).toBeNull();
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

    it('turns into the grid as soon as the apps arrive', async () => {
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

  it('has no grid or list switch any more: it is always a grid', () => {
    expect(root.querySelector('.seg')).toBeNull();
    expect(buttonByText('Lista')).toBeUndefined();
    expect(buttonByText('Grade')).toBeUndefined();
  });

  it('never offers "ligar e abrir", a timer, voice or a switch to the PC', () => {
    const text = (root.textContent ?? '').toLowerCase();
    expect(text).not.toContain('ligar e abrir');
    expect(text).not.toContain('30 min');
    expect(text).not.toContain('voz');
  });
});

/** O que o convite "só controlar a TV" concede: a TV inteira, menos editar atalhos. */
const TV_CONTROL_ONLY = ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history'];

describe('AppsPanel for a guest', () => {
  afterEach(() => localStorage.clear());

  const open = async (
    shortcuts = createFakeTvStore().shortcuts(),
    permissions: readonly string[] = TV_CONTROL_ONLY,
  ) => {
    const store = createFakeTvStore();
    store.shortcuts.set(shortcuts);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
      permissions,
    });
    const fixture = TestBed.createComponent(AppsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('opens apps and refreshes the list, but offers neither edit, rename nor pin (owner only)', async () => {
    const root = await open();

    expect(root.querySelectorAll('.launch')).toHaveLength(3);
    expect(root.querySelector('.edit-toggle')).toBeNull();
    expect(root.querySelector('.tools')).toBeNull();
    expect(root.querySelector('[data-move]')).toBeNull();
    expect(root.querySelector('button[aria-label^="Mover"]')).toBeNull();
    expect(root.querySelector('button[aria-label^="Renomear"]')).toBeNull();
    expect(
      root.querySelector('button[aria-label^="Fixar"], button[aria-label^="Tirar"]'),
    ).toBeNull();
    expect(root.querySelector('button.refresh')).not.toBeNull();
  });

  it('sees "Limpar a TV" like any other TV command', async () => {
    const root = await open();

    const clean = root.querySelector<HTMLButtonElement>('button.clean')!;
    expect(clean.getAttribute('aria-label')).toBe('Limpar a TV');
    expect(clean.hasAttribute('aria-disabled')).toBe(false);
  });

  it('opens the apps out of the control too, and is told only that a tap opens them (no mention of Editar)', async () => {
    const root = await open([
      makeShortcut(1, { tvLabel: 'Spotify' }),
      makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
      makeShortcut(3, { tvLabel: 'Netflix', enabled: false, installed: false }),
    ]);
    expect([...root.querySelectorAll('h3')].map((h) => h.textContent?.trim())).toEqual([
      'No controle',
      'Fora do controle',
    ]);
    // O que saiu da TV não aparece; o que só está fora do controle abre.
    expect([...root.querySelectorAll('.item .name')].map((el) => el.textContent?.trim())).toEqual([
      'Spotify',
      'YouTube',
    ]);
    expect(root.querySelectorAll<HTMLButtonElement>('.launch:disabled')).toHaveLength(0);
    expect(root.querySelector('#apps-group-rest')!.parentElement!.textContent).toContain(
      'Toque para abrir.',
    );
    expect(root.textContent).not.toContain('Editar');
    expect(root.textContent).not.toContain('fixe');
  });

  it('has no empty "No controle" section when nothing is in the control', async () => {
    const root = await open([makeShortcut(1, { enabled: false })]);
    expect([...root.querySelectorAll('h3')].map((h) => h.textContent?.trim())).toEqual([
      'Fora do controle',
    ]);
    expect(root.textContent).not.toContain('Toque em Editar');
  });

  describe('by permission', () => {
    const toolbar = (root: HTMLElement) => ({
      refresh: root.querySelector('button.refresh') !== null,
      clean: root.querySelector('button.clean') !== null,
      edit: root.querySelector('.edit-toggle') !== null,
    });
    const shortcuts = [
      makeShortcut(1, { tvLabel: 'Spotify' }),
      makeShortcut(2, { tvLabel: 'YouTube', enabled: false }),
    ];

    it('with launch and edit (and no control) it opens and edits, but cannot clean the TV', async () => {
      const root = await open(shortcuts, ['module:tv', 'tv:launch', 'tv:edit-shortcuts']);
      expect(toolbar(root)).toEqual({ refresh: true, clean: false, edit: true });
      expect(root.querySelectorAll('button.launch')).toHaveLength(2);
      expect(root.querySelector('#apps-group-rest')!.parentElement!.textContent).toContain(
        'Toque para abrir. Para ter no controle, fixe em Editar.',
      );
    });

    it('with control only the panel is short: the cleaning and nothing else (no grid, no search, no refresh, no edit)', async () => {
      const root = await open(shortcuts, ['module:tv', 'tv:control']);
      expect(toolbar(root)).toEqual({ refresh: false, clean: true, edit: false });
      for (const selector of [
        '.grid',
        '.launch',
        '.item',
        'input[type="search"]',
        '.bar',
        'h3',
        '.empty',
      ]) {
        expect(root.querySelector(selector), selector).toBeNull();
      }
      const clean = root.querySelector<HTMLButtonElement>('button.clean')!;
      expect(clean.textContent?.trim()).toBe('Limpar a TV');
      expect(clean.hasAttribute('aria-disabled')).toBe(false);
      expect(root.textContent).toContain(
        'Fecha os apps abertos na TV e libera memória, sem derrubar o controle.',
      );
      expect(root.querySelectorAll('button')).toHaveLength(1);
    });

    it('with control only and no list yet, the panel is the same: it does not wait for the apps nor offer to ask for them', async () => {
      const root = await open([], ['module:tv', 'tv:control']);
      expect(root.textContent).not.toContain('Carregando');
      expect(root.textContent).not.toContain('Buscar apps da TV');
      expect(root.querySelector('button.clean')).not.toBeNull();
    });

    it('with control only the cleaning dims when the remote cannot send, and the reason is told', async () => {
      const store = createFakeTvStore();
      store.canSend.set(false);
      store.disabledReason.set('Sem rede: o controle precisa de internet.');
      TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'Alice',
        role: 'guest',
        permissions: ['module:tv', 'tv:control'],
      });
      const fixture = TestBed.createComponent(AppsPanel);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      const clean = root.querySelector<HTMLButtonElement>('button.clean')!;
      expect(clean.getAttribute('aria-disabled')).toBe('true');
      expect(clean.disabled).toBe(false);
      expect(root.textContent).toContain('Sem rede: o controle precisa de internet.');

      // Rodando: o botão diz o que acontece, e o aviso é o mesmo do painel completo.
      store.canSend.set(true);
      store.disabledReason.set(null);
      store.cleaning.set(true);
      fixture.detectChanges();
      expect(root.querySelector('button.clean')!.textContent?.trim()).toBe('Limpando a TV…');
      expect(root.querySelector('.cleaning')?.textContent).toContain('Limpando a TV');
    });

    it('without launch the tiles are figures: no button, same name under the icon, nothing to tap', async () => {
      const root = await open(shortcuts, ['module:tv', 'tv:edit-shortcuts']);
      expect(root.querySelectorAll('button.launch')).toHaveLength(0);
      expect(
        [...root.querySelectorAll('.launch.still .name')].map((el) => el.textContent?.trim()),
      ).toEqual(['Spotify', 'YouTube']);
      for (const tile of root.querySelectorAll('.launch.still')) {
        expect(tile.tagName).not.toBe('BUTTON');
        expect(tile.hasAttribute('tabindex')).toBe(false);
        expect(tile.getAttribute('role')).toBeNull();
      }
      expect(toolbar(root)).toEqual({ refresh: false, clean: false, edit: true });
      // A dica só fala do que a pessoa tem: fixar em Editar, e nada de "toque para abrir".
      const rest = root.querySelector('#apps-group-rest')!.parentElement!.textContent;
      expect(rest).toContain('Para ter no controle, fixe em Editar.');
      expect(rest).not.toContain('Toque para abrir');
    });

    it('without a list yet, only who can open apps is offered the button that asks the TV for it', async () => {
      const withLaunch = await open([], ['module:tv', 'tv:launch']);
      expect(withLaunch.textContent).toContain('Buscar apps da TV');
      TestBed.resetTestingModule();
      const withoutLaunch = await open([], ['module:tv', 'tv:edit-shortcuts']);
      expect(withoutLaunch.textContent).not.toContain('Buscar apps da TV');
      expect(withoutLaunch.textContent).toContain(
        'Peça a quem cuida da TV para atualizar a lista de apps.',
      );
      expect(withoutLaunch.querySelector('.empty button')).toBeNull();
    });

    it('leaves the edit mode when the permission to edit goes away with the panel open', async () => {
      const store = createFakeTvStore();
      TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
      const session = TestBed.inject(SessionState);
      const grant = (...permissions: string[]) =>
        session.setUser({
          id: '1',
          email: 'a@b.c',
          displayName: 'Alice',
          role: 'guest',
          permissions,
        });
      grant('module:tv', 'tv:launch', 'tv:edit-shortcuts');
      const fixture = TestBed.createComponent(AppsPanel);
      const root = fixture.nativeElement as HTMLElement;
      fixture.detectChanges();
      await fixture.whenStable();
      root.querySelector<HTMLButtonElement>('.edit-toggle')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(root.querySelector('.tools')).not.toBeNull();

      grant('module:tv', 'tv:launch');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(root.querySelector('.tools')).toBeNull();
      expect(root.querySelector('.edit-toggle')).toBeNull();
      expect(root.querySelectorAll('button.launch').length).toBeGreaterThan(0);
    });
  });
});
