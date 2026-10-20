import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, HOT, createFakeTvStore, makeShortcut } from '../tv-test-kit';
import { ControlPage } from './control.page';

describe('ControlPage', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ControlPage>>;
  let root: HTMLElement;
  const scrollTo = vi.fn();

  const render = () => fixture.detectChanges();
  const byLabel = (label: string, scope: ParentNode = root) =>
    scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const panels = () => root.querySelectorAll<HTMLElement>('.panel');
  const shortcutNames = () =>
    [...root.querySelectorAll('.shortcut .name')].map((el) => el.textContent?.trim());

  beforeEach(() => {
    store = createFakeTvStore();
    scrollTo.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      value: scrollTo,
      configurable: true,
    });
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(ControlPage);
    render();
    root = fixture.nativeElement;
  });

  describe('top row', () => {
    it('starts with the fixed Apps chip, then the favourite shortcuts as chips', () => {
      const chip = root.querySelector<HTMLButtonElement>('.top > .apps-chip')!;
      expect(chip.textContent?.trim()).toBe('Apps');
      expect(chip.getAttribute('aria-label')).toBe('Apps da TV');
      expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
      expect(chip.nextElementSibling?.matches('ul.shortcuts')).toBe(true);
      // O chip não rola junto com os atalhos.
      expect(chip.closest('.shortcuts')).toBeNull();
    });

    it('shows the enabled shortcuts as "Atalho n" when nothing else names them, never the package', () => {
      expect(shortcutNames()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
      expect(root.textContent).not.toContain('pacote.app');
    });

    it('names a chip by the owner name, then by the name the agent publishes, then "Atalho n"', () => {
      store.shortcuts.set([
        makeShortcut(1, { customLabel: 'Sala', tvLabel: 'YouTube' }),
        makeShortcut(2, { tvLabel: 'Spotify' }),
        makeShortcut(3),
      ]);
      render();
      expect(shortcutNames()).toEqual(['Sala', 'Spotify', 'Atalho 3']);
    });

    it('keeps the order the API gave (by position), uses the owner name and hides the disabled ones', () => {
      store.shortcuts.set([
        makeShortcut(1, { customLabel: 'Sala' }),
        makeShortcut(2, { enabled: false }),
        makeShortcut(3),
        makeShortcut(5),
        makeShortcut(4, { customLabel: 'Quarto' }),
      ]);
      render();
      // A ordem é a da lista do store (que já vem ordenada por posição); o controle não reordena.
      expect(shortcutNames()).toEqual(['Sala', 'Atalho 3', 'Atalho 5', 'Quarto']);
    });

    it('opens a shortcut on tap, only when the remote can send', () => {
      root.querySelector<HTMLButtonElement>('.shortcut')!.click();
      expect(store.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));

      store.canSend.set(false);
      render();
      const first = root.querySelector<HTMLButtonElement>('.shortcut')!;
      expect(first.getAttribute('aria-disabled')).toBe('true');
      expect(first.disabled).toBe(false); // continua focável: a faixa rolável precisa de algo que o teclado alcance
      first.click();
      expect(store.launch).toHaveBeenCalledTimes(1);
    });

    it('with no shortcuts there is no error text: only the Apps chip', () => {
      store.shortcuts.set([]);
      render();
      expect(root.querySelectorAll('.shortcut')).toHaveLength(0);
      expect(root.querySelector('.apps-chip')).not.toBeNull();
      expect(root.querySelector('.top')?.textContent?.trim()).toBe('Apps');
      expect(root.textContent).not.toMatch(/sem atalhos/i);
      expect(root.querySelector('.none, .top a')).toBeNull();
    });

    it('says nothing while the list is still loading', () => {
      store.shortcuts.set(null);
      render();
      expect(root.querySelector('.top')?.textContent?.trim()).toBe('Apps');
    });

    it('the Apps chip asks the page to open the Apps panel, and it works without a remote link', () => {
      const opened = vi.fn();
      fixture.componentInstance.openApps.subscribe(opened);
      store.canSend.set(false);
      render();
      const chip = root.querySelector<HTMLButtonElement>('.apps-chip')!;
      chip.click();
      // Leva o próprio botão, para o painel devolver o foco a ele ao fechar.
      expect(opened).toHaveBeenCalledExactlyOnceWith(chip);
    });

    it('no touchpad chip or button is left in the top row', () => {
      expect(root.querySelector('.square, .modes')).toBeNull();
      expect(root.querySelector('.top')?.textContent).not.toMatch(/touchpad/i);
      expect(byLabel('Trocar para o modo touchpad')).toBeNull();
    });
  });

  describe('fixed parts', () => {
    it('has both pills and the eight round buttons', () => {
      expect(root.querySelectorAll('.pill')).toHaveLength(2);
      const round = root.querySelectorAll('.round-grid .round');
      expect(round).toHaveLength(8);
      expect([...round].map((el) => el.getAttribute('aria-label'))).toEqual([
        'Voltar',
        'Início da TV',
        'Menu',
        'Teclado',
        'Anterior',
        'Reproduzir ou pausar',
        'Próxima',
        'Mudo',
      ]);
    });

    it('keeps everything that is not directions, touchpad or numbers outside the part that slides', () => {
      const fixed = [
        '.top',
        '.apps-chip',
        '.shortcuts',
        '.pill.volume',
        '.round-grid',
        'app-page-dots',
        '.stage app-page-dots',
      ];
      for (const selector of fixed) {
        const element = root.querySelector(selector);
        expect(element, selector).not.toBeNull();
        expect(element!.closest('.pager'), selector).toBeNull();
      }
      expect(
        root.querySelectorAll('.pager .pill, .pager .round, .pager .shortcut, .pager .apps-chip'),
      ).toHaveLength(0);
      // O que desliza: as direções, o touchpad e os números.
      expect(root.querySelectorAll('.pager .seg')).toHaveLength(4);
      expect(root.querySelectorAll('.pager .pad')).toHaveLength(1);
      expect(root.querySelectorAll('.pager .num')).toHaveLength(10);
    });

    it('the keyboard button is a button that asks the page to open the Keyboard panel', () => {
      const opened = vi.fn();
      fixture.componentInstance.openKeyboard.subscribe(opened);
      const button = byLabel('Teclado');
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(root.querySelector('a')).toBeNull();
      button.click();
      expect(opened).toHaveBeenCalledExactlyOnceWith(button);
    });

    it.each([
      ['Aumentar o volume', 'VOLUME_UP'],
      ['Diminuir o volume', 'VOLUME_DOWN'],
      ['Próximo canal', 'CHANNEL_UP'],
      ['Canal anterior', 'CHANNEL_DOWN'],
      ['Voltar', 'BACK'],
      ['Início da TV', 'HOME'],
      ['Menu', 'MENU'],
      ['Mudo', 'MUTE'],
      ['Reproduzir ou pausar', 'PLAY_PAUSE'],
      ['Anterior', 'MEDIA_PREVIOUS'],
      ['Próxima', 'MEDIA_NEXT'],
    ])('%s sends %s', async (label, key) => {
      byLabel(label).click();
      await fixture.whenStable();
      expect(store.sendKey).toHaveBeenCalledWith(key);
    });

    it('shows the volume from the state, or a dash and a spoken "desconhecido"', () => {
      const level = () => root.querySelector('.level[role="img"]')!;
      expect(level().getAttribute('aria-label')).toBe('Volume 22');
      expect(level().textContent).toContain('22');

      store.state.set({ ...HOT, volume: null });
      render();
      expect(level().getAttribute('aria-label')).toBe('Volume desconhecido');
      expect(level().textContent).toContain('–');

      store.state.set(null);
      render();
      expect(level().getAttribute('aria-label')).toBe('Volume desconhecido');
    });

    it('has no voice button and no timer', () => {
      const text = root.textContent ?? '';
      expect(root.innerHTML.toLowerCase()).not.toContain('microfone');
      expect(text).not.toMatch(/30 min/);
      expect(text).not.toMatch(/\bPC\b/);
    });
  });

  describe('the three pages of the central block', () => {
    it('are the directions with OK, the touchpad and the numbers, in that order', () => {
      expect(panels()).toHaveLength(3);
      expect(panels()[0].querySelector('app-directional-ring')).not.toBeNull();
      expect(panels()[0].querySelector('.ok')?.textContent?.trim()).toBe('OK');
      expect(panels()[1].querySelector('app-touchpad-surface .pad')).not.toBeNull();
      expect(panels()[2].querySelector('app-number-pad')).not.toBeNull();
    });

    it('no longer has a mode switch: no "Botões | Touchpad" chips and no swap of the ring', () => {
      expect(root.querySelector('.chip, [aria-pressed]')).toBeNull();
      expect(root.querySelector('app-directional-ring')).not.toBeNull();
      expect(root.querySelector('app-touchpad-surface')).not.toBeNull();
    });

    it('the touchpad leaves a margin at the sides, so a page swipe can start outside it', () => {
      expect(panels()[1].classList.contains('touch')).toBe(true);
    });

    it('the numbers page has 0 to 9 and the source, and nothing else', () => {
      const third = panels()[2];
      const numbers = [...third.querySelectorAll('.num')].map((el) =>
        el.getAttribute('aria-label'),
      );
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => `Número ${n}`));
      expect(third.querySelector('.source')?.textContent?.trim()).toBe('Origem');
      expect(third.querySelectorAll('button')).toHaveLength(11);
    });

    it.each([
      ['Número 0', 'NUM_0'],
      ['Número 7', 'NUM_7'],
    ])('%s sends %s', async (label, key) => {
      byLabel(label, panels()[2]).click();
      await fixture.whenStable();
      expect(store.sendKey).toHaveBeenCalledWith(key);
    });

    it('the source button only sends the key that opens the TV picker', async () => {
      panels()[2].querySelector<HTMLButtonElement>('.source')!.click();
      await fixture.whenStable();
      expect(store.sendKey).toHaveBeenCalledWith('INPUT');
    });
  });

  describe('paging', () => {
    /** Um grupo de pontos só, parado embaixo do palco. */
    const dots = () => [...root.querySelectorAll<HTMLButtonElement>('app-page-dots .dot')];
    const current = () => dots().map((d) => d.getAttribute('aria-current'));

    it('has one labelled dot per page (three), the first current', () => {
      expect(dots().map((d) => d.getAttribute('aria-label'))).toEqual([
        'Página 1 de 3',
        'Página 2 de 3',
        'Página 3 de 3',
      ]);
      expect(current()).toEqual(['true', null, null]);
    });

    it('names the pages for the screen reader too', () => {
      expect([...panels()].map((el) => el.getAttribute('aria-label'))).toEqual([
        'Página 1 de 3',
        'Página 2 de 3',
        'Página 3 de 3',
      ]);
    });

    it('tapping a dot scrolls the carousel to that page and marks it', () => {
      Object.defineProperty(root.querySelector('.pager'), 'clientWidth', { value: 300 });
      dots()[1].click();
      render();
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 300 }));
      expect(current()).toEqual([null, 'true', null]);
      dots()[2].click();
      render();
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 600 }));
      expect(current()).toEqual([null, null, 'true']);
    });

    it('there is a single group of dots, outside the pages', () => {
      expect(root.querySelectorAll('app-page-dots')).toHaveLength(1);
      expect(root.querySelector('.pager app-page-dots')).toBeNull();
    });

    it('the arrow keys on the dots turn the page too, through the three pages and stopping at the ends', () => {
      Object.defineProperty(root.querySelector('.pager'), 'clientWidth', { value: 300 });
      const group = root.querySelector('app-page-dots [role="group"]')!;
      const press = (key: string) => {
        group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        render();
      };
      press('ArrowRight');
      expect(current()).toEqual([null, 'true', null]);
      press('ArrowRight');
      expect(current()).toEqual([null, null, 'true']);
      press('ArrowRight');
      expect(current()).toEqual([null, null, 'true']);
      press('ArrowLeft');
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 300 }));
      expect(current()).toEqual([null, 'true', null]);
    });

    it('follows the scroll position and keeps the pages out of sight inert', () => {
      const pager = root.querySelector<HTMLElement>('.pager')!;
      const inert = () => [...panels()].map((panel) => panel.hasAttribute('inert'));
      expect(inert()).toEqual([false, true, true]);

      Object.defineProperty(pager, 'clientWidth', { value: 300 });
      Object.defineProperty(pager, 'scrollLeft', { value: 290, configurable: true });
      pager.dispatchEvent(new Event('scroll'));
      render();
      expect(current()).toEqual([null, 'true', null]);
      expect(inert()).toEqual([true, false, true]);

      Object.defineProperty(pager, 'scrollLeft', { value: 600, configurable: true });
      pager.dispatchEvent(new Event('scroll'));
      render();
      expect(inert()).toEqual([true, true, false]);
    });
  });

  it('every key button is disabled when the remote cannot send', () => {
    store.canSend.set(false);
    render();
    const keyButtons = root.querySelectorAll('.pill-btn, .round-grid button.round, .num, .source');
    expect(keyButtons.length).toBeGreaterThan(20);
    // Teclado é a exceção: abrir o painel não manda nada à TV (ver abaixo).
    const sending = [...keyButtons].filter(
      (button) => button.getAttribute('aria-label') !== 'Teclado',
    );
    for (const button of sending) expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('the keyboard button is not a key: it stays usable, because typing needs the panel to explain why it cannot send', () => {
    store.canSend.set(false);
    render();
    expect(byLabel('Teclado').hasAttribute('disabled')).toBe(false);
  });
});
