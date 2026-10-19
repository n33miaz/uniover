import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeShortcut } from '../tv-test-kit';
import { AppsPage } from './apps.page';

describe('AppsPage', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<AppsPage>>;
  let root: HTMLElement;

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

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(AppsPage);
    root = fixture.nativeElement;
    await render();
  });

  it('lists every shortcut, named "Atalho n" by default, with the package as small text', () => {
    expect(names()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
    expect([...root.querySelectorAll('.package')].map((el) => el.textContent)).toEqual([
      'pacote.app1',
      'pacote.app2',
      'pacote.app3',
    ]);
    expect(root.textContent).not.toContain('Rótulo da TV');
  });

  it('shows the owner name instead of "Atalho n"', async () => {
    store.shortcuts.set([makeShortcut(1, { customLabel: 'Sala' })]);
    await render();
    expect(names()).toEqual(['Sala']);
  });

  it('opens an app on the TV', async () => {
    launcher(2).click();
    await render();
    expect(store.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
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

  describe('rename', () => {
    const startRename = async (label = 'Renomear Atalho 2') => {
      byLabel(label).click();
      await render();
    };
    const type = (text: string) => {
      const input = root.querySelector<HTMLInputElement>('input')!;
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
      const input = root.querySelector<HTMLInputElement>('input')!;
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
      root.querySelector<HTMLButtonElement>('.secondary')!.click();
      await render();
      expect(root.querySelector('form')).toBeNull();
      expect(store.renameShortcut).not.toHaveBeenCalled();
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

  it('refreshes the list on request', async () => {
    root.querySelector<HTMLButtonElement>('.refresh')!.click();
    await render();
    expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
  });

  it('says what to do when there are no shortcuts yet', async () => {
    store.shortcuts.set([]);
    await render();
    expect(root.querySelector('.note')?.textContent).toContain(
      'Nenhum atalho ainda. Toque em Atualizar lista',
    );
    expect(root.querySelector('.list')).toBeNull();
  });

  it('says it is loading before the first list arrives', async () => {
    store.shortcuts.set(null);
    await render();
    expect(root.querySelector('.note')?.textContent).toContain('Carregando os atalhos');
  });

  it('never offers "ligar e abrir", a timer, voice or a switch to the PC', () => {
    const text = (root.textContent ?? '').toLowerCase();
    expect(text).not.toContain('ligar e abrir');
    expect(text).not.toContain('30 min');
    expect(text).not.toContain('voz');
  });
});
