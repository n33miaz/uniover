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

  describe('page 1 with buttons', () => {
    it('has the ring, both pills and the six round buttons in the order of the reference', () => {
      expect(root.querySelector('app-directional-ring')).not.toBeNull();
      expect(root.querySelectorAll('.pill')).toHaveLength(2);
      const round = panels()[0].querySelectorAll('.round-grid .round');
      expect(round).toHaveLength(6);
      expect([...round].map((el) => el.getAttribute('aria-label'))).toEqual([
        'Teclado',
        'Início da TV',
        'Menu',
        'Mudo',
        'Reproduzir ou pausar',
        'Voltar',
      ]);
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
    ])('%s sends %s', async (label, key) => {
      byLabel(label, panels()[0]).click();
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

    it('keeps back, home and volume at hand', () => {
      switchToTouchpad();
      const labels = [...root.querySelectorAll('.touch-row .round')].map((el) =>
        el.getAttribute('aria-label'),
      );
      expect(labels).toEqual(['Voltar', 'Início da TV', 'Diminuir o volume', 'Aumentar o volume']);
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
    it('has the numbers 0 to 9, the media buttons and the source', () => {
      const second = panels()[1];
      const numbers = [...second.querySelectorAll('.num')].map((el) =>
        el.getAttribute('aria-label'),
      );
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => `Número ${n}`));
      const media = [...second.querySelectorAll('.media-row .round')].map((el) =>
        el.getAttribute('aria-label'),
      );
      expect(media).toEqual(['Anterior', 'Reproduzir ou pausar', 'Próxima']);
      expect(second.querySelector('.source')?.textContent?.trim()).toBe('Origem');
    });

    it.each([
      ['Número 0', 'NUM_0'],
      ['Número 7', 'NUM_7'],
      ['Anterior', 'MEDIA_PREVIOUS'],
      ['Reproduzir ou pausar', 'PLAY_PAUSE'],
      ['Próxima', 'MEDIA_NEXT'],
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
    /** Cada página tem o seu grupo de pontos; aqui os da primeira. */
    const dots = () => [...panels()[0].querySelectorAll<HTMLButtonElement>('.dot')];

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
    expect(keyButtons.length).toBeGreaterThan(10);
    for (const button of keyButtons) expect(button.hasAttribute('disabled')).toBe(true);
  });
});
