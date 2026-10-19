import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    fixture = TestBed.createComponent(ControlPage);
    render();
    root = fixture.nativeElement;
  });

  describe('shortcuts', () => {
    it('shows the enabled shortcuts as "Atalho n" and never the TV label or the package', () => {
      expect(shortcutNames()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
      expect(root.textContent).not.toContain('Rótulo da TV');
      expect(root.textContent).not.toContain('pacote.app');
    });

    it('uses the owner name when there is one and hides the disabled ones, keeping the numbers stable', () => {
      store.shortcuts.set([
        makeShortcut(1, { customLabel: 'Sala' }),
        makeShortcut(2, { enabled: false }),
        makeShortcut(3),
      ]);
      render();
      expect(shortcutNames()).toEqual(['Sala', 'Atalho 3']);
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

    it('points to the Apps tab when there are none yet, and says nothing while loading', () => {
      store.shortcuts.set([]);
      render();
      const link = root.querySelector<HTMLAnchorElement>('.none a')!;
      expect(link.textContent?.trim()).toBe('Sem atalhos ainda. Veja a aba Apps.');
      expect(link.getAttribute('href')).toBe('/tv/apps');

      store.shortcuts.set(null);
      render();
      expect(root.querySelector('.none')).toBeNull();
    });
  });

  describe('buttons mode', () => {
    it('has the ring in the first page of the stage, both pills and the eight round buttons', () => {
      expect(panels()[0].querySelector('app-directional-ring')).not.toBeNull();
      expect(panels()[0].querySelector('.ok')?.textContent?.trim()).toBe('OK');
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

    it('keeps everything that is not directions or numbers outside the part that slides', () => {
      const fixed = [
        '.top',
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
      expect(root.querySelectorAll('.pager .pill, .pager .round, .pager .shortcut')).toHaveLength(
        0,
      );
      // O que desliza: só as direções e os números.
      expect(root.querySelectorAll('.pager .seg')).toHaveLength(4);
      expect(root.querySelectorAll('.pager .num')).toHaveLength(10);
    });

    it('the keyboard button leads to the Keyboard tab', () => {
      const link = root.querySelector<HTMLAnchorElement>('a.round')!;
      expect(link.getAttribute('href')).toBe('/tv/teclado');
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

  describe('touchpad mode', () => {
    const switchToTouchpad = () => {
      byLabel('Trocar para o modo touchpad').click();
      render();
    };

    it('the square button swaps the ring for the touchpad and shows the mode chips', () => {
      switchToTouchpad();
      expect(root.querySelector('app-touchpad-surface')).not.toBeNull();
      expect(root.querySelector('app-directional-ring')).toBeNull();
      const chips = [...root.querySelectorAll<HTMLButtonElement>('.chip')];
      expect(chips.map((c) => c.textContent?.trim())).toEqual(['Botões', 'Touchpad']);
      expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    });

    it('puts the touchpad in the first page of the stage and keeps the fixed buttons where they are', () => {
      switchToTouchpad();
      expect(panels()[0].querySelector('app-touchpad-surface')).not.toBeNull();
      expect(root.querySelectorAll('.round-grid .round')).toHaveLength(8);
      for (const label of ['Voltar', 'Início da TV', 'Diminuir o volume', 'Aumentar o volume']) {
        expect(byLabel(label).closest('.pager')).toBeNull();
      }
    });

    it('the Botões chip goes back to the ring', () => {
      switchToTouchpad();
      const buttonsChip = root.querySelector<HTMLButtonElement>('.chip')!;
      buttonsChip.click();
      render();
      expect(root.querySelector('app-directional-ring')).not.toBeNull();
      expect(root.querySelector('app-touchpad-surface')).toBeNull();
      expect(byLabel('Trocar para o modo touchpad')).not.toBeNull();
    });
  });

  describe('page 2', () => {
    it('has the numbers 0 to 9 and the source, and nothing else', () => {
      const second = panels()[1];
      const numbers = [...second.querySelectorAll('.num')].map((el) =>
        el.getAttribute('aria-label'),
      );
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => `Número ${n}`));
      expect(second.querySelector('.source')?.textContent?.trim()).toBe('Origem');
      expect(second.querySelectorAll('button')).toHaveLength(11);
    });

    it.each([
      ['Número 0', 'NUM_0'],
      ['Número 7', 'NUM_7'],
    ])('%s sends %s', async (label, key) => {
      byLabel(label, panels()[1]).click();
      await fixture.whenStable();
      expect(store.sendKey).toHaveBeenCalledWith(key);
    });

    it('the source button only sends the key that opens the TV picker', async () => {
      panels()[1].querySelector<HTMLButtonElement>('.source')!.click();
      await fixture.whenStable();
      expect(store.sendKey).toHaveBeenCalledWith('INPUT');
    });
  });

  describe('paging', () => {
    /** Um grupo de pontos só, parado embaixo do palco. */
    const dots = () => [...root.querySelectorAll<HTMLButtonElement>('app-page-dots .dot')];

    it('has one labelled dot per page, the first current', () => {
      expect(dots().map((d) => d.getAttribute('aria-label'))).toEqual([
        'Página 1 de 2',
        'Página 2 de 2',
      ]);
      expect(dots().map((d) => d.getAttribute('aria-current'))).toEqual(['true', null]);
    });

    it('tapping a dot scrolls the carousel and marks it', () => {
      Object.defineProperty(root.querySelector('.pager'), 'clientWidth', { value: 300 });
      dots()[1].click();
      render();
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 300 }));
      expect(dots().map((d) => d.getAttribute('aria-current'))).toEqual([null, 'true']);
    });

    it('there is a single group of dots, outside the pages', () => {
      expect(root.querySelectorAll('app-page-dots')).toHaveLength(1);
      expect(root.querySelector('.pager app-page-dots')).toBeNull();
    });

    it('the arrow keys on the dots turn the page too, so the gesture is not the only way', () => {
      Object.defineProperty(root.querySelector('.pager'), 'clientWidth', { value: 300 });
      const group = root.querySelector('app-page-dots [role="group"]')!;
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      render();
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 300 }));
      expect(dots().map((d) => d.getAttribute('aria-current'))).toEqual([null, 'true']);
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      render();
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 0 }));
      expect(dots().map((d) => d.getAttribute('aria-current'))).toEqual(['true', null]);
    });

    it('follows the scroll position and keeps the page out of sight inert', () => {
      const pager = root.querySelector<HTMLElement>('.pager')!;
      expect(panels()[0].hasAttribute('inert')).toBe(false);
      expect(panels()[1].hasAttribute('inert')).toBe(true);

      Object.defineProperty(pager, 'clientWidth', { value: 300 });
      Object.defineProperty(pager, 'scrollLeft', { value: 290, configurable: true });
      pager.dispatchEvent(new Event('scroll'));
      render();
      expect(dots().map((d) => d.getAttribute('aria-current'))).toEqual([null, 'true']);
      expect(panels()[0].hasAttribute('inert')).toBe(true);
      expect(panels()[1].hasAttribute('inert')).toBe(false);
    });
  });

  it('every key button is disabled when the remote cannot send', () => {
    store.canSend.set(false);
    render();
    const keyButtons = root.querySelectorAll('.pill-btn, .round-grid button.round, .num, .source');
    expect(keyButtons.length).toBeGreaterThan(20);
    for (const button of keyButtons) expect(button.hasAttribute('disabled')).toBe(true);
  });
});
