import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvSelection } from '../data/tv-selection';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, HOT, createFakeTvStore, makeShortcut, makeTv, pngIcon } from '../tv-test-kit';
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
  /** O atalho é o ícone do app: o nome está no nome acessível do botão. */
  const shortcutNames = () =>
    [...root.querySelectorAll('.shortcut')].map((el) => el.getAttribute('aria-label'));

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
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
    it('has only the favourite shortcuts in the top row: the Apps button lives in the page header', () => {
      const row = root.querySelector('.top')!;
      expect(row.firstElementChild?.matches('ul.shortcuts')).toBe(true);
      expect(root.querySelector('.apps-chip')).toBeNull();
      expect(root.querySelector('button[aria-label="Apps da TV"]')).toBeNull();
      // Nada além da lista de atalhos: nem o chip antigo, nem a dica (que só aparece com a fileira vazia).
      expect([...row.children].map((child) => child.tagName)).toEqual(['UL']);
      expect(row.querySelector('.hint')).toBeNull();
      expect(row.querySelectorAll('.shortcut')).toHaveLength(3);
    });

    it('shows the enabled shortcuts as "Atalho n" when nothing else names them, never the package', () => {
      expect(shortcutNames()).toEqual(['Atalho 1', 'Atalho 2', 'Atalho 3']);
      expect(root.textContent).not.toContain('pacote.app');
    });

    it('shows the app icon on the chip, not its name, and still opens the app', () => {
      store.shortcuts.set([
        makeShortcut(1, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }),
        makeShortcut(2),
      ]);
      render();
      expect(root.querySelectorAll('.shortcut img')).toHaveLength(1);
      expect(root.querySelectorAll('.shortcut .name')).toHaveLength(0);
      expect(root.querySelector('.shortcut')!.textContent?.trim()).toBe('');
      expect(shortcutNames()).toEqual(['Spotify', 'Atalho 2']);
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

    it('without tv:launch the shortcuts are figures: no button, nothing opens, no vibration', () => {
      TestBed.inject(SessionState).setUser({
        id: '1',
        email: 'a@b.c',
        displayName: 'Alice',
        role: 'guest',
        permissions: ['module:tv', 'tv:control'],
      });
      render();
      expect(root.querySelectorAll('button.shortcut')).toHaveLength(0);
      const figures = root.querySelectorAll<HTMLElement>('.shortcut.still');
      expect(figures).toHaveLength(3);
      figures[0].click();
      expect(store.launch).not.toHaveBeenCalled();
      // O controle em si segue inteiro: só os atalhos perderam o toque.
      expect(byLabel('Mudo')).not.toBeNull();
    });

    it('gives a short vibration when a shortcut opens an app, and none when it cannot send', () => {
      const vibrateSpy = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrateSpy, configurable: true });
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      try {
        root.querySelector<HTMLButtonElement>('.shortcut')!.click();
        expect(vibrateSpy).toHaveBeenCalledTimes(1);
        store.canSend.set(false);
        render();
        root.querySelector<HTMLButtonElement>('.shortcut')!.click();
        expect(vibrateSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(navigator, 'vibrate');
      }
    });

    it('with no shortcuts the row shows a quiet hint where to pin apps, not an error and not a button', () => {
      store.shortcuts.set([]);
      render();
      expect(root.querySelectorAll('.shortcut')).toHaveLength(0);
      expect(root.querySelector('.shortcuts')).toBeNull();
      expect(root.querySelector('.top .hint')?.textContent?.trim()).toBe(
        'Fixe apps aqui: abra o menu, no topo.',
      );
      expect(root.querySelector('.top .hint')!.closest('button, a')).toBeNull();
      expect(root.textContent).not.toMatch(/sem atalhos/i);
    });

    it('says nothing while the list is still loading', () => {
      store.shortcuts.set(null);
      render();
      expect(root.querySelector('.top')?.textContent?.trim()).toBe('');
      expect(root.querySelector('.top .hint')).toBeNull();
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
        root.querySelectorAll('.pager .pill, .pager .round, .pager .shortcut, .pager .top'),
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

    it('shows the volume from the state, and never a bare dash when there is no reading', () => {
      const level = () => root.querySelector('.level[role="img"]')!;
      expect(level().getAttribute('aria-label')).toBe('Volume 22');
      expect(level().textContent).toContain('22');
      expect(level().querySelector('.unread')).toBeNull();

      store.state.set({ ...HOT, volume: null });
      render();
      expect(level().getAttribute('aria-label')).toBe('Volume sem leitura');
      expect(level().textContent).not.toContain('–');
      expect(level().querySelector('.unread')).not.toBeNull();

      store.state.set(null);
      render();
      expect(level().getAttribute('aria-label')).toBe('Volume sem leitura');
    });

    it('answers the touch with the confirmed steps when the volume cannot be read', () => {
      const level = () => root.querySelector('.level[role="img"]')!;
      store.state.set({ ...HOT, volume: null });
      store.volumeNudge.set(3);
      render();
      expect(level().textContent).toContain('+3');
      expect(level().getAttribute('aria-label')).toBe('Volume +3');
      expect(level().querySelector('.unread')).toBeNull();

      store.volumeNudge.set(-2);
      render();
      expect(level().textContent).toContain('−2');

      // Com leitura real o número da TV vale, e o retorno do toque não aparece por cima.
      store.state.set({ ...HOT, volume: 30 });
      render();
      expect(level().textContent).toContain('30');
      expect(level().textContent).not.toContain('−2');
    });

    it('has no voice button and no timer', () => {
      const text = root.textContent ?? '';
      expect(root.innerHTML.toLowerCase()).not.toContain('microfone');
      expect(text).not.toMatch(/30 min/);
      expect(text).not.toMatch(/\bPC\b/);
    });
  });

  describe('the three pages of the central block', () => {
    it('are the directions with OK, the numbers and, last, the touchpad, in that order', () => {
      expect(panels()).toHaveLength(3);
      expect(panels()[0].querySelector('app-directional-ring')).not.toBeNull();
      expect(panels()[0].querySelector('.ok')?.textContent?.trim()).toBe('OK');
      expect(panels()[1].querySelector('app-number-pad')).not.toBeNull();
      expect(panels()[2].querySelector('app-touchpad-surface .pad')).not.toBeNull();
    });

    it('no longer has a mode switch: no "Botões | Touchpad" chips and no swap of the ring', () => {
      expect(root.querySelector('.chip, [aria-pressed]')).toBeNull();
      expect(root.querySelector('app-directional-ring')).not.toBeNull();
      expect(root.querySelector('app-touchpad-surface')).not.toBeNull();
    });

    it('the touchpad leaves a margin at the sides, so a page swipe can start outside it', () => {
      expect(panels()[2].classList.contains('touch')).toBe(true);
      expect(panels()[2].querySelector('.edge')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('the numbers page has 0 to 9 and the source, and nothing else', () => {
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

    it('the arrow keys, Home and End on the stage itself turn the page; on a button inside they do not', () => {
      const pager = root.querySelector<HTMLElement>('.pager')!;
      Object.defineProperty(pager, 'clientWidth', { value: 300 });
      const press = (key: string, target: Element = pager) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        render();
        return event.defaultPrevented;
      };
      expect(press('ArrowRight')).toBe(true);
      expect(current()).toEqual([null, 'true', null]);
      expect(press('End')).toBe(true);
      expect(current()).toEqual([null, null, 'true']);
      expect(press('ArrowRight')).toBe(true);
      expect(current()).toEqual([null, null, 'true']);
      expect(press('Home')).toBe(true);
      expect(current()).toEqual(['true', null, null]);
      expect(press('ArrowLeft')).toBe(true);
      expect(current()).toEqual(['true', null, null]);
      expect(press('ArrowRight', panels()[0].querySelector('button')!)).toBe(false);
      expect(current()).toEqual(['true', null, null]);
      expect(press('a')).toBe(false);
    });

    it('hands the dots the fractional scroll position to follow the finger', () => {
      const pager = root.querySelector<HTMLElement>('.pager')!;
      Object.defineProperty(pager, 'clientWidth', { value: 300 });
      Object.defineProperty(pager, 'scrollLeft', { value: 150, configurable: true });
      pager.dispatchEvent(new Event('scroll'));
      render();
      const thumb = root.querySelector<HTMLElement>('app-page-dots .thumb')!;
      // Meio caminho entre o primeiro e o segundo ponto: centro em 22 + 44 * 0,5 e o destaque alongado.
      expect(thumb.style.getPropertyValue('--w')).toBe('34px');
      expect(thumb.style.getPropertyValue('--x')).toBe('27px');
    });

    it('puts the chosen page back in view when the tab comes back or the size changes', () => {
      const pager = root.querySelector<HTMLElement>('.pager')!;
      Object.defineProperty(pager, 'clientWidth', { value: 300 });
      let left = 0;
      Object.defineProperty(pager, 'scrollLeft', { get: () => left, configurable: true });
      dots()[1].click();
      render();
      left = 300;
      pager.dispatchEvent(new Event('scroll'));
      scrollTo.mockClear();

      // O navegador perdeu a posição enquanto a aba estava em segundo plano.
      left = 0;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });

      scrollTo.mockClear();
      left = 270;
      window.dispatchEvent(new Event('pageshow'));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });

      // Já no lugar, nada é pedido.
      scrollTo.mockClear();
      left = 300;
      window.dispatchEvent(new Event('pageshow'));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('remembers the page for the life of the tab and opens on it after a reload', async () => {
      dots()[2].click();
      render();
      await fixture.whenStable();
      expect(sessionStorage.getItem('uniover.tv.stage-page')).toBe('2');

      const again = TestBed.createComponent(ControlPage);
      again.detectChanges();
      const marks = [...again.nativeElement.querySelectorAll('app-page-dots .dot')].map((d) =>
        (d as HTMLElement).getAttribute('aria-current'),
      );
      expect(marks).toEqual([null, null, 'true']);
    });

    it('works without storage (private mode) and ignores a nonsense saved value', () => {
      sessionStorage.setItem('uniover.tv.stage-page', '9');
      const again = TestBed.createComponent(ControlPage);
      expect(() => again.detectChanges()).not.toThrow();
      expect(
        again.nativeElement.querySelector('app-page-dots .dot').getAttribute('aria-current'),
      ).toBe('true');
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const third = TestBed.createComponent(ControlPage);
      expect(() => third.detectChanges()).not.toThrow();
      spy.mockRestore();
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

  it('the keyboard button is not a key: it stays focusable and opens the panel that explains why it cannot send, but looks off', () => {
    expect(byLabel('Teclado').classList.contains('off')).toBe(false);
    store.canSend.set(false);
    render();
    const keyboard = byLabel('Teclado');
    expect(keyboard.hasAttribute('disabled')).toBe(false);
    // Apagado como os demais botões de comando: nada ali parece pronto para mandar texto à TV.
    expect(keyboard.classList.contains('off')).toBe(true);
    store.canSend.set(true);
    render();
    expect(byLabel('Teclado').classList.contains('off')).toBe(false);
  });

  describe('what Personalizar chooses', () => {
    const prefs = () => TestBed.inject(TvPrefs);
    const remote = () => root.querySelector<HTMLElement>('.remote')!;
    const roundLabels = () =>
      [...root.querySelectorAll('.round-grid .round')].map((el) => el.getAttribute('aria-label'));

    afterEach(() => localStorage.clear());

    it('gives the bottom keys the comfortable scale by default, and follows the size at once', () => {
      expect(remote().style.getPropertyValue('--key-scale')).toBe('1');
      prefs().set({ buttonSize: 'compact' });
      render();
      expect(remote().style.getPropertyValue('--key-scale')).toBe('0.9');
      prefs().set({ buttonSize: 'large' });
      render();
      expect(remote().style.getPropertyValue('--key-scale')).toBe('1.15');
    });

    it('lays the round keys out in four columns, three for the large size and two without the media keys', () => {
      const cols = () => root.querySelector('.round-grid')!.getAttribute('data-cols');
      expect(cols()).toBe('4');
      prefs().set({ buttonSize: 'large' });
      render();
      expect(cols()).toBe('3');
      prefs().set({ showMedia: false });
      render();
      expect(cols()).toBe('2');
      prefs().set({ buttonSize: 'comfortable' });
      render();
      expect(cols()).toBe('2');
    });

    it('hides the four media keys, keeping the first four, and brings them back', () => {
      prefs().set({ showMedia: false });
      render();
      expect(roundLabels()).toEqual(['Voltar', 'Início da TV', 'Menu', 'Teclado']);
      for (const label of ['Anterior', 'Reproduzir ou pausar', 'Próxima', 'Mudo']) {
        expect(byLabel(label)).toBeNull();
      }

      prefs().set({ showMedia: true });
      render();
      expect(roundLabels()).toHaveLength(8);
    });

    it('hides the channel pill, and the volume pill stays', () => {
      prefs().set({ showChannel: false });
      render();
      expect(root.querySelectorAll('.pill')).toHaveLength(1);
      expect(root.querySelector('.pill.volume')).not.toBeNull();
      expect(root.querySelector('[aria-label="Canal"]')).toBeNull();
      expect(byLabel('Próximo canal')).toBeNull();
      expect(root.querySelector('.bottom')!.classList.contains('no-channel')).toBe(true);

      prefs().set({ showChannel: true });
      render();
      expect(root.querySelectorAll('.pill')).toHaveLength(2);
      expect(root.querySelector('.bottom')!.classList.contains('no-channel')).toBe(false);
    });

    describe('layout of the volume and channel pills', () => {
      const bottom = () => root.querySelector<HTMLElement>('.bottom')!;
      /** As peças do bloco de baixo na ordem do documento, que tem de ser a da tela. */
      const bottomOrder = () =>
        [...bottom().children].map((el) =>
          el.matches('.round-grid') ? 'round' : (el.getAttribute('aria-label') ?? el.tagName),
        );
      const pillLabels = (name: string) =>
        [...root.querySelectorAll(`[aria-label="${name}"] > *`)].map((el) =>
          el.matches('.level') ? 'level' : el.getAttribute('aria-label'),
        );

      it('has the pills on the sides by default: volume, round keys and channel, in that order', () => {
        expect(bottom().getAttribute('data-pills')).toBe('sides');
        expect(bottomOrder()).toEqual(['Volume', 'round', 'Canal']);
        expect(pillLabels('Volume')).toEqual(['Aumentar o volume', 'level', 'Diminuir o volume']);
        expect(pillLabels('Canal')).toEqual(['Próximo canal', 'level', 'Canal anterior']);
      });

      it('puts the two pills in a row above the round keys, in the document too, so Tab follows the screen', () => {
        prefs().set({ pillLayout: 'row' });
        render();
        expect(bottom().getAttribute('data-pills')).toBe('row');
        expect(bottomOrder()).toEqual(['Volume', 'Canal', 'round']);
        // Deitada a pílula lê-se da esquerda para a direita: menos, o nível, mais.
        expect(pillLabels('Volume')).toEqual(['Diminuir o volume', 'level', 'Aumentar o volume']);
        expect(pillLabels('Canal')).toEqual(['Canal anterior', 'level', 'Próximo canal']);
      });

      it('has the same buttons, with the same accessible names, in both layouts', () => {
        const names = () =>
          [...bottom().querySelectorAll('button')]
            .map((el) => el.getAttribute('aria-label'))
            .sort();
        const before = names();
        expect(before).toHaveLength(12);
        prefs().set({ pillLayout: 'row' });
        render();
        expect(names()).toEqual(before);
        prefs().set({ pillLayout: 'sides' });
        render();
        expect(names()).toEqual(before);
      });

      it.each(['sides', 'row'] as const)(
        'still sends the volume and channel keys with the pills in "%s"',
        async (pillLayout) => {
          prefs().set({ pillLayout });
          render();
          for (const [label, key] of [
            ['Aumentar o volume', 'VOLUME_UP'],
            ['Diminuir o volume', 'VOLUME_DOWN'],
            ['Próximo canal', 'CHANNEL_UP'],
            ['Canal anterior', 'CHANNEL_DOWN'],
          ]) {
            store.sendKey.mockClear();
            byLabel(label).click();
            await fixture.whenStable();
            expect(store.sendKey, label).toHaveBeenCalledWith(key);
          }
        },
      );

      it('keeps the volume level, spoken and shown, in the row layout too', () => {
        prefs().set({ pillLayout: 'row' });
        render();
        const level = root.querySelector('.pill.volume .level[role="img"]')!;
        expect(level.getAttribute('aria-label')).toBe('Volume 22');
        expect(level.textContent).toContain('22');
        expect(
          root.querySelector<HTMLElement>('.pill.volume')!.style.getPropertyValue('--level'),
        ).toBe('22%');
      });

      it('lays the round keys out in four columns whatever the size or the media keys, since they have the whole width', () => {
        prefs().set({ pillLayout: 'row' });
        const cols = () => root.querySelector('.round-grid')!.getAttribute('data-cols');
        render();
        expect(cols()).toBe('4');
        prefs().set({ buttonSize: 'large' });
        render();
        expect(cols()).toBe('4');
        prefs().set({ showMedia: false });
        render();
        expect(cols()).toBe('4');
        expect(roundLabels()).toEqual(['Voltar', 'Início da TV', 'Menu', 'Teclado']);
      });

      it('with the channel hidden the volume pill stays alone above the round keys, in the row layout', () => {
        prefs().set({ pillLayout: 'row', showChannel: false });
        render();
        expect(bottomOrder()).toEqual(['Volume', 'round']);
        expect(root.querySelectorAll('.pill')).toHaveLength(1);
        expect(bottom().classList.contains('no-channel')).toBe(true);
        expect(byLabel('Próximo canal')).toBeNull();
        // E o canal volta no lugar certo da fileira.
        prefs().set({ showChannel: true });
        render();
        expect(bottomOrder()).toEqual(['Volume', 'Canal', 'round']);
      });

      it('switches back to the sides at once, with the same elements and no leftovers', () => {
        prefs().set({ pillLayout: 'row' });
        render();
        prefs().set({ pillLayout: 'sides' });
        render();
        expect(bottom().getAttribute('data-pills')).toBe('sides');
        expect(bottomOrder()).toEqual(['Volume', 'round', 'Canal']);
        expect(root.querySelectorAll('.pill')).toHaveLength(2);
        expect(root.querySelectorAll('.round-grid .round')).toHaveLength(8);
      });
    });

    it('keeps the ring, the numbers, the touchpad and the dots whatever is hidden', () => {
      prefs().set({ showMedia: false, showChannel: false, buttonSize: 'large' });
      render();
      expect(panels()).toHaveLength(3);
      expect(root.querySelectorAll('app-page-dots .dot')).toHaveLength(3);
      expect(root.querySelector('.ok')).not.toBeNull();
    });

    describe('page the stage opens on', () => {
      const marks = (host: HTMLElement) =>
        [...host.querySelectorAll('app-page-dots .dot')].map((d) => d.getAttribute('aria-current'));
      const reopen = () => {
        const again = TestBed.createComponent(ControlPage);
        again.detectChanges();
        return again.nativeElement as HTMLElement;
      };

      it.each([
        ['directions', [true, false, false]],
        ['numbers', [false, true, false]],
        ['touchpad', [false, false, true]],
      ] as const)('"%s" opens on that page, whatever the tab remembers', (startPage, expected) => {
        sessionStorage.setItem('uniover.tv.stage-page', '2');
        prefs().set({ startPage });
        expect(marks(reopen())).toEqual(expected.map((on) => (on ? 'true' : null)));
      });

      it('"last" opens on the page the tab remembers, and on the first one when it remembers none', () => {
        prefs().set({ startPage: 'last' });
        expect(marks(reopen())).toEqual(['true', null, null]);
        sessionStorage.setItem('uniover.tv.stage-page', '1');
        expect(marks(reopen())).toEqual([null, 'true', null]);
      });

      it('is the last used page by default, as the control always did', () => {
        sessionStorage.setItem('uniover.tv.stage-page', '2');
        expect(marks(reopen())).toEqual([null, null, 'true']);
      });
    });
  });

  describe('what the TV in use can do', () => {
    const prefs = () => TestBed.inject(TvPrefs);
    const roundLabels = () =>
      [...root.querySelectorAll('.round-grid .round')].map((el) => el.getAttribute('aria-label'));
    const cols = () => root.querySelector('.round-grid')!.getAttribute('data-cols');
    const useTv = (overrides: Parameters<typeof makeTv>[1]) => {
      TestBed.inject(TvSelection).setTvs([makeTv('tv', { isDefault: true, ...overrides })]);
      render();
    };
    // Um agente de antes de declarar teclas: só tem a Fonte, que o contrato antigo já trazia.
    const SAMSUNG = { kind: 'samsung', capabilities: ['tv.remote', 'tv.kind.samsung'] } as const;

    afterEach(() => localStorage.clear());

    it('has no Keyboard button on a TV that does not take text, and no empty cell where it was', () => {
      useTv(SAMSUNG);
      expect(byLabel('Teclado')).toBeNull();
      // Sete botões fixos em quatro colunas deixariam uma célula vazia: a Fonte, que toda TV tem, a fecha.
      expect(roundLabels()).toEqual([
        'Voltar',
        'Início da TV',
        'Menu',
        'Anterior',
        'Reproduzir ou pausar',
        'Próxima',
        'Mudo',
        'Fonte',
      ]);
      expect(cols()).toBe('4');
      expect(root.querySelector('.round-grid')!.hasAttribute('data-short')).toBe(false);
    });

    it('keeps the Keyboard on an Android, whatever else it lacks, and adds nothing to a full grid', () => {
      useTv({ capabilities: ['tv.remote', 'tv.kind.android', 'tv.key.v3', 'tv.key.INPUT'] });
      expect(byLabel('Teclado')).not.toBeNull();
      expect(roundLabels()).toHaveLength(8);
      expect(root.querySelector('.round-grid')!.hasAttribute('data-short')).toBe(false);
    });

    it('re-counts the columns without the Keyboard: three without the media keys, three in a row', () => {
      useTv(SAMSUNG);
      prefs().set({ showMedia: false });
      render();
      expect(roundLabels()).toEqual(['Voltar', 'Início da TV', 'Menu']);
      expect(cols()).toBe('3');
      expect(root.querySelector('.round-grid')!.hasAttribute('data-short')).toBe(false);
      prefs().set({ pillLayout: 'row' });
      render();
      expect(cols()).toBe('3');
    });

    describe('extra buttons', () => {
      const FULL_SAMSUNG = {
        kind: 'samsung',
        capabilities: [
          'tv.remote',
          'tv.kind.samsung',
          'tv.key.v3',
          ...['INPUT', 'GUIDE', 'INFO', 'TOOLS', 'RED', 'BLUE', 'PLAY'].map(
            (key) => `tv.key.${key}`,
          ),
        ],
      } as const;
      const extras = () => roundLabels().slice(7);

      it('completes the last row of a Samsung with the most important key it declares', () => {
        useTv(FULL_SAMSUNG);
        expect(extras()).toEqual(['Fonte']);
        expect(root.querySelectorAll('.round-grid .round')).toHaveLength(8);
      });

      it('shows the keys the person chose, in the grid and by their names, with the row completed', () => {
        useTv(FULL_SAMSUNG);
        prefs().set({ extraKeys: ['GUIDE'] });
        render();
        expect(extras()).toEqual(['Guia']);
        prefs().set({ extraKeys: ['RED', 'BLUE'] });
        render();
        expect(extras()).toEqual(['Vermelho', 'Azul', 'Fonte', 'Guia', 'Informações']);
        expect(roundLabels().length % 4).toBe(0);
      });

      it('draws a colour key as a coloured disc, an icon key as its icon and the others as a short word', () => {
        useTv(FULL_SAMSUNG);
        prefs().set({ extraKeys: ['RED', 'PLAY', 'TOOLS'] });
        render();
        const faces = [...root.querySelectorAll('.round-grid .round')].slice(7);
        expect(faces[0]!.querySelector('.swatch')?.getAttribute('data-color')).toBe('red');
        expect(faces[1]!.querySelector('app-tv-icon')).not.toBeNull();
        expect(faces[2]!.querySelector('.word')?.textContent).toBe('Ferram.');
      });

      it('sends the extra key the button names', () => {
        useTv(FULL_SAMSUNG);
        prefs().set({ extraKeys: ['GUIDE'] });
        render();
        byLabel('Guia').click();
        expect(store.sendKey).toHaveBeenCalledWith('GUIDE');
      });

      it('keeps every combination of options without an empty cell', () => {
        useTv(FULL_SAMSUNG);
        for (const buttonSize of ['compact', 'comfortable', 'large'] as const) {
          for (const showMedia of [true, false]) {
            for (const pillLayout of ['sides', 'row'] as const) {
              for (const extraKeys of [null, ['BLUE'], ['RED', 'BLUE', 'GUIDE']] as const) {
                prefs().set({ buttonSize, showMedia, pillLayout, extraKeys });
                render();
                const columns = Number(cols());
                expect(roundLabels().length % columns).toBe(0);
              }
            }
          }
        }
      });
    });

    it('does not hide anything while nothing is known about the TV (agent off)', () => {
      useTv({ kind: null, capabilities: [], online: false });
      expect(byLabel('Teclado')).not.toBeNull();
    });
  });
});
