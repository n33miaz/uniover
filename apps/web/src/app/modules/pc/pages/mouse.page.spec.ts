import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PcArmed } from '../data/pc-armed';
import { PcInput } from '../data/pc-input';
import { PcPrefs } from '../data/pc-prefs';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { LONG_PRESS_MS } from '../input/pad-gesture';
import { MousePage } from './mouse.page';

describe('MousePage', () => {
  let prefs: PcPrefs;
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<MousePage>>;
  let root: HTMLElement;

  const pad = () => root.querySelector<HTMLElement>('.pad')!;
  const button = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.buttons button')].find(
      (b) => b.textContent?.trim() === name,
    )!;

  function pointer(
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    id: number,
    x: number,
    y: number,
    timeStamp: number,
  ) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.assign(event, { pointerId: id, isPrimary: id === 1 });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    pad().dispatchEvent(event);
  }

  beforeEach(() => {
    localStorage.clear();
    store = createFakePcStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: PcStore, useValue: store }],
    });
    // Os botões de clique são opcionais (desligados por padrão): os testes dos botões os ligam.
    prefs = TestBed.inject(PcPrefs);
    prefs.set({ clickButtons: true });
    fixture = TestBed.createComponent(MousePage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  describe('Backspace held down on a PC with pc.key.v2 (real pending counts)', () => {
    const erase = () =>
      root.querySelector<HTMLButtonElement>('app-pc-action-bar [aria-label="Apagar"]')!;
    const down = () => erase().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    const up = () => erase().dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    const flushAll = async () => {
      for (let round = 0; round < 8; round++) await Promise.resolve();
    };

    beforeEach(() =>
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }),
    );
    afterEach(() => vi.useRealTimers());

    it('sends no batch while a request is still pending, so at most one batch is left to run after the finger lifts', async () => {
      store.capabilities.set(['pc.key.v2']);
      fixture.detectChanges();
      let answer: () => void = () => undefined;
      // O primeiro toque fica sem resposta: há um pedido pendente.
      store.sendKey.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () => resolve(null);
          }),
      );
      down();
      await vi.advanceTimersByTimeAsync(420 + 120 * 20);
      // Vinte rodadas se passaram e nenhum lote saiu: nada empilhou atrás do pedido pendente.
      expect(store.sendKey.mock.calls).toEqual([['BACKSPACE', []]]);

      // O pedido responde; o que foi devido sai em UM lote, de no máximo oito.
      store.sendKey.mockImplementation(() => new Promise(() => undefined)); // o lote também fica pendente
      answer();
      await vi.advanceTimersByTimeAsync(120);
      await flushAll();
      expect(store.sendKey.mock.calls).toHaveLength(2);
      const [, , options] = store.sendKey.mock.calls[1] as unknown as [
        string,
        unknown,
        { repeat: number },
      ];
      expect(options.repeat).toBeGreaterThanOrEqual(2);
      expect(options.repeat).toBeLessThanOrEqual(8);

      // O lote não responde: nada mais sai, e soltar o dedo encerra tudo.
      await vi.advanceTimersByTimeAsync(120 * 20);
      expect(store.sendKey.mock.calls).toHaveLength(2);
      up();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.sendKey.mock.calls).toHaveLength(2);
    });

    it('on a PC without the capability the old rule stays: up to two keys pending', async () => {
      store.sendKey.mockImplementation(() => new Promise(() => undefined));
      down();
      await vi.advanceTimersByTimeAsync(420 + 140 * 10);
      up();
      // O toque e uma repetição: com duas pendentes a rodada pula, como sempre, e nenhum pedido leva `repeat`.
      expect(TestBed.inject(PcInput).pending).toBe(2);
      expect(store.sendKey.mock.calls.every((call) => call.length === 2)).toBe(true);
    });
  });

  describe('the panel of keys and the switcher', () => {
    it('the panel button is off while the Alt is held, and the panel does not reopen over the switcher bar', () => {
      store.capabilities.set(['pc.key.v2']);
      store.heldKeys.set(['ALT']);
      fixture.detectChanges();
      const more = root.querySelector<HTMLButtonElement>(
        'app-pc-action-bar [aria-label="Mais teclas"]',
      )!;
      expect(more.disabled).toBe(true);
      more.click();
      fixture.detectChanges();
      expect(root.querySelector('app-pc-key-panel')).toBeNull();
      store.heldKeys.set([]);
      fixture.detectChanges();
      expect(more.disabled).toBe(false);
    });

    const bar = (name: string) =>
      root.querySelector<HTMLButtonElement>(`app-pc-action-bar [aria-label="${name}"]`)!;
    const panelButton = (selector: string) => root.querySelector<HTMLButtonElement>(selector);

    it('a PC without pc.key.v2 has no button for the new keys in the panel', () => {
      bar('Mais teclas').click();
      fixture.detectChanges();
      expect(root.querySelector('app-pc-key-panel')).not.toBeNull();
      expect(panelButton('[data-more-toggle]')).toBeNull();
    });

    it('a PC with it has the button, and the panel offers the digits and "Alt+Tab"', () => {
      store.capabilities.set(['pc.key.v2']);
      bar('Mais teclas').click();
      fixture.detectChanges();
      panelButton('[data-more-toggle]')!.click();
      fixture.detectChanges();
      expect(panelButton('[data-key="D5"]')).not.toBeNull();
      expect(panelButton('[data-switch-window]')).not.toBeNull();
    });

    it('"Alt+Tab" holds the Alt and gives the first Tab, and the panel closes when the Alt is held (the bar takes its place)', async () => {
      store.capabilities.set(['pc.key.v2']);
      bar('Mais teclas').click();
      fixture.detectChanges();
      panelButton('[data-more-toggle]')!.click();
      fixture.detectChanges();
      panelButton('[data-switch-window]')!.click();
      for (let round = 0; round < 8; round++) await Promise.resolve();
      expect(store.sendKey.mock.calls).toEqual([
        ['ALT', [], { action: 'DOWN' }],
        ['TAB', []],
      ]);
      store.heldKeys.set(['ALT']); // o store segurou
      fixture.detectChanges();
      expect(root.querySelector('app-pc-key-panel')).toBeNull();
    });
  });

  it('explains itself to a screen reader and points to the buttons', () => {
    expect(pad().getAttribute('aria-labelledby')).toBe('pad-help');
    const help = root.querySelector('#pad-help')!.textContent ?? '';
    expect(help).toContain('Touchpad');
    expect(help).toContain('barra');
  });

  it('one finger sliding moves the pointer and never clicks', () => {
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointermove', 1, 120, 100, 16);
    pointer('pointerup', 1, 120, 100, 32);
    expect(store.beginGesture).toHaveBeenCalledTimes(1);
    expect(store.movePointer).toHaveBeenCalledWith(20, 0, 16);
    expect(store.click).not.toHaveBeenCalled();
    expect(store.endGesture).toHaveBeenCalledTimes(1);
  });

  it('a quick still touch is a left click', () => {
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointerup', 1, 100, 100, 90);
    expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
    expect(store.movePointer).not.toHaveBeenCalled();
  });

  it('two fingers sliding scroll, and a quick still touch of both is a right click', () => {
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointerdown', 2, 140, 100, 0);
    pointer('pointermove', 1, 100, 130, 16);
    pointer('pointermove', 2, 140, 130, 16);
    pointer('pointerup', 1, 100, 130, 40);
    pointer('pointerup', 2, 140, 130, 40);
    expect(store.scrollPointer).toHaveBeenCalled();
    expect(store.movePointer).not.toHaveBeenCalled();
    expect(store.endGesture).toHaveBeenCalledTimes(1);

    store.click.mockClear();
    pointer('pointerdown', 1, 100, 100, 1_000);
    pointer('pointerdown', 2, 140, 100, 1_010);
    pointer('pointerup', 1, 100, 100, 1_080);
    pointer('pointerup', 2, 140, 100, 1_090);
    expect(store.click).toHaveBeenCalledExactlyOnceWith('RIGHT');
  });

  it('does not react while the PC is not connected', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointerup', 1, 100, 100, 50);
    expect(store.click).not.toHaveBeenCalled();
    expect(store.beginGesture).not.toHaveBeenCalled();
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('.buttons button')].every((b) => b.disabled),
    ).toBe(true);
  });

  it('a cancelled gesture clicks nothing and still sends what was waiting', () => {
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointercancel', 1, 100, 100, 20);
    expect(store.click).not.toHaveBeenCalled();
    expect(store.endGesture).toHaveBeenCalledTimes(1);
  });

  it('the Left and Right buttons click, and Drag holds the left button', () => {
    button('Esquerdo').click();
    button('Direito').click();
    expect(store.click.mock.calls).toEqual([['LEFT'], ['RIGHT']]);
    button('Arrastar').click();
    expect(store.toggleDrag).toHaveBeenCalledTimes(1);
  });

  it('shows Drag as pressed while the button is held', () => {
    store.dragging.set(true);
    fixture.detectChanges();
    expect(button('Arrastar').getAttribute('aria-pressed')).toBe('true');
  });

  it('works from the keyboard: arrows move, Enter clicks', () => {
    pad().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(store.movePointer).toHaveBeenCalledWith(10, 0, 16);
    pad().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
  });

  it('leaving the screen while dragging releases the button', () => {
    store.dragging.set(true);
    fixture.destroy();
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('scrolling passes the time of each step, so a faster swipe can scroll farther', () => {
    pointer('pointerdown', 1, 100, 100, 0);
    pointer('pointerdown', 2, 140, 100, 0);
    pointer('pointermove', 1, 100, 130, 40);
    pointer('pointermove', 2, 140, 130, 40);
    // O centro anda 15 px a cada dedo que se mexe; o primeiro passo leva os 40 ms desde o toque.
    expect(store.scrollPointer.mock.calls.map(([, dy, elapsed]) => [dy, elapsed])).toEqual([
      [15, 40],
      [15, 0],
    ]);
  });

  describe('taps on a PC with pc.click.v2', () => {
    const tap = (x: number, down: number, up: number) => {
      pointer('pointerdown', 1, x, 100, down);
      pointer('pointerup', 1, x, 100, up);
    };

    beforeEach(() => {
      store.capabilities.set(['pc.click.v2']);
      fixture.detectChanges();
    });

    it('a tap carries the armed Ctrl and Shift (a Ctrl+click) and lets them go', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('SHIFT');
      armed.toggle('CTRL');
      tap(100, 0, 90);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT', undefined, {
        modifiers: ['CTRL', 'SHIFT'],
        gapMs: undefined,
      });
      expect(armed.armed().size).toBe(0);
    });

    it('the Windows key stays armed: a click does not carry it', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('WIN');
      armed.toggle('ALT');
      tap(100, 0, 90);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT', undefined, {
        modifiers: ['ALT'],
        gapMs: undefined,
      });
      expect([...armed.armed()]).toEqual(['WIN']);
    });

    it('the second tap of a double tap carries the gap since the first click', () => {
      tap(100, 0, 60);
      tap(103, 200, 260);
      expect(store.click).toHaveBeenNthCalledWith(1, 'LEFT', undefined, {
        modifiers: [],
        gapMs: undefined,
      });
      expect(store.click).toHaveBeenNthCalledWith(2, 'LEFT', undefined, {
        modifiers: [],
        gapMs: 200,
      });
    });

    it('the Ctrl armed for a tap is on BOTH taps of a double tap (a Ctrl+double click)', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      tap(103, 200, 260);
      expect(store.click).toHaveBeenNthCalledWith(1, 'LEFT', undefined, {
        modifiers: ['CTRL'],
        gapMs: undefined,
      });
      expect(store.click).toHaveBeenNthCalledWith(2, 'LEFT', undefined, {
        modifiers: ['CTRL'],
        gapMs: 200,
      });
      expect(armed.armed().size).toBe(0);
    });

    it('the Ctrl is on EVERY tap of a triple tap, and the gap of each is the one since the one before', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      tap(103, 200, 260);
      tap(100, 330, 390);
      expect(store.click.mock.calls.map(([, , options]) => options)).toEqual([
        { modifiers: ['CTRL'], gapMs: undefined },
        { modifiers: ['CTRL'], gapMs: 200 },
        { modifiers: ['CTRL'], gapMs: 130 },
      ]);
    });

    it('a tap that starts again (no gap) takes only what is armed now, and the sequence starts over', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      tap(100, 1000, 1060); // fora da sequência: o Ctrl não o acompanha
      tap(103, 1200, 1260); // e este, que continua o de cima, leva o que ele levou (nada)
      expect(store.click.mock.calls.map(([, , options]) => options?.modifiers)).toEqual([
        ['CTRL'],
        [],
        [],
      ]);
    });

    it('the sequence is forgotten when a tap goes out the plain way (no pc.click.v2 or no PC)', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60); // leva o Ctrl
      store.phase.set('offline');
      fixture.detectChanges();
      // O Enter da superfície clica sem passar pelo gesto: é o retorno antecipado de `press`.
      pad().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      store.phase.set('ready');
      fixture.detectChanges();
      tap(103, 200, 260); // continua o toque de 60 ms, mas a sequência já foi esquecida
      expect(store.click.mock.calls.map(([, , options]) => options?.modifiers)).toEqual([
        ['CTRL'],
        undefined,
        [],
      ]);
    });

    it('a new modifier armed between the two taps wins for the second', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      armed.toggle('SHIFT');
      tap(103, 200, 260);
      expect(store.click).toHaveBeenNthCalledWith(2, 'LEFT', undefined, {
        modifiers: ['SHIFT'],
        gapMs: 200,
      });
    });

    it('a plain tap after a double tap starts from nothing: the Ctrl does not follow it', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      tap(103, 200, 260);
      tap(100, 900, 960); // fora do tempo do toque duplo
      expect(store.click).toHaveBeenNthCalledWith(3, 'LEFT', undefined, {
        modifiers: [],
        gapMs: undefined,
      });
    });

    it('a lone Ctrl tap is not carried to a tap that comes much later', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      tap(100, 0, 60);
      tap(100, 2000, 2060);
      expect(store.click).toHaveBeenNthCalledWith(2, 'LEFT', undefined, {
        modifiers: [],
        gapMs: undefined,
      });
    });

    it('a right click of two fingers also carries the armed keys', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('SHIFT');
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 0);
      pointer('pointerup', 1, 100, 100, 40);
      pointer('pointerup', 2, 140, 100, 45);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('RIGHT', undefined, {
        modifiers: ['SHIFT'],
        gapMs: undefined,
      });
    });

    it('with the PC away nothing is spent: the keys stay armed', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      store.phase.set('offline');
      fixture.detectChanges();
      pad().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(armed.has('CTRL')).toBe(true);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
    });
  });

  describe('taps on a PC from before pc.click.v2', () => {
    it('a tap goes out as it always did and what is armed stays armed (it is not lost without effect)', () => {
      const armed = TestBed.inject(PcArmed);
      armed.toggle('CTRL');
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerup', 1, 100, 100, 60);
      pointer('pointerdown', 1, 103, 100, 200);
      pointer('pointerup', 1, 103, 100, 260);
      expect(store.click.mock.calls).toEqual([['LEFT'], ['LEFT']]);
      expect(armed.has('CTRL')).toBe(true);
    });
  });

  describe('long press', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('a finger held still presses the left button and lifting it releases, with no click', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
      expect(store.startDrag).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(store.startDrag).toHaveBeenCalledTimes(1);
      expect(store.release).not.toHaveBeenCalled();
      pointer('pointerup', 1, 100, 100, 700);
      // O dedo não vai mais tentar de novo: o soltar insiste.
      expect(store.release).toHaveBeenCalledExactlyOnceWith({ persistent: true });
      expect(store.click).not.toHaveBeenCalled();
    });

    it('moving while pressed drags: the pointer follows the finger', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      pointer('pointermove', 1, 130, 110, 520);
      expect(store.movePointer).toHaveBeenCalledWith(30, 10, expect.any(Number));
      pointer('pointerup', 1, 130, 110, 560);
      expect(store.release).toHaveBeenCalledTimes(1);
    });

    it('a system cancel while pressed releases the button', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      pointer('pointercancel', 1, 100, 100, 520);
      expect(store.release).toHaveBeenCalledTimes(1);
    });

    it('leaving the screen while pressed releases the button', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      fixture.destroy();
      expect(store.release).toHaveBeenCalled();
    });

    it('when the Drag button already holds the left button, a long press does not take it over', () => {
      store.dragging.set(true);
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      pointer('pointerup', 1, 100, 100, 600);
      expect(store.startDrag).not.toHaveBeenCalled();
      expect(store.release).not.toHaveBeenCalled();
    });

    it('when the Drag button press is still on its way, a long press does not take it over or release it', () => {
      store.buttonBusy = true;
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      pointer('pointerup', 1, 100, 100, 800);
      expect(store.startDrag).not.toHaveBeenCalled();
      expect(store.release).not.toHaveBeenCalled();
    });

    it('shows the grab at once (before the PC answers) and takes it away when the finger leaves', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      fixture.detectChanges();
      expect(pad().classList.contains('holding')).toBe(true);
      expect(root.querySelector('.holding-label')?.textContent?.trim()).toBe('Arrastando');
      pointer('pointerup', 1, 100, 100, 800);
      fixture.detectChanges();
      expect(pad().classList.contains('holding')).toBe(false);
      expect(root.querySelector('.holding-label')?.textContent?.trim()).toBe('');
    });

    it('keeps one live region in the DOM and only its text changes', () => {
      const region = () => root.querySelector('.holding-label')!;
      const before = region();
      expect(before.getAttribute('role')).toBe('status');
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      fixture.detectChanges();
      expect(region()).toBe(before);
      expect(region().textContent?.trim()).toBe('Arrastando');
      pointer('pointerup', 1, 100, 100, 800);
      fixture.detectChanges();
      expect(region()).toBe(before);
    });

    it('if the press could not be made, the surface stops saying it is dragging but the lift still releases (the safety UP may have failed too)', async () => {
      store.startDrag.mockResolvedValueOnce({
        kind: 'timeout',
        message: 'O PC não respondeu a tempo.',
      });
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();
      expect(pad().classList.contains('holding')).toBe(false);
      expect(root.querySelector('.holding-label')?.textContent?.trim()).toBe('');
      expect(store.release).not.toHaveBeenCalled();
      pointer('pointerup', 1, 100, 100, 800);
      expect(store.release).toHaveBeenCalledExactlyOnceWith({ persistent: true });
    });

    it('two fingers landing before the long-press time scroll as before and press nothing', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(LONG_PRESS_MS - 10);
      pointer('pointerdown', 2, 140, 100, LONG_PRESS_MS - 10);
      vi.advanceTimersByTime(1_000);
      pointer('pointermove', 1, 100, 130, 1_600);
      pointer('pointermove', 2, 140, 130, 1_600);
      expect(store.startDrag).not.toHaveBeenCalled();
      expect(store.scrollPointer).toHaveBeenCalled();
      expect(store.movePointer).not.toHaveBeenCalled();
    });

    it('a failed long press does not release a newer press (the Drag button pressed meanwhile) when the finger lifts', async () => {
      store.startDrag.mockImplementationOnce(() => {
        store.pressEpoch += 1;
        return Promise.resolve({ kind: 'timeout', message: 'O PC não respondeu a tempo.' });
      });
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
      // O "Arrastar" é tocado com o dedo ainda na tela e começa um aperto mais novo.
      store.pressEpoch += 1;
      store.dragging.set(true);
      pointer('pointerup', 1, 100, 100, 800);
      expect(store.release).not.toHaveBeenCalled();
    });

    it('a quick tap still clicks and starts no drag', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerup', 1, 100, 100, 90);
      vi.advanceTimersByTime(1_000);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
      expect(store.startDrag).not.toHaveBeenCalled();
    });

    it('shows the held state on the surface', () => {
      store.dragging.set(true);
      fixture.detectChanges();
      expect(pad().classList.contains('holding')).toBe(true);
    });
  });

  describe('Drag button while the PC goes away', () => {
    const dragButton = () => button('Arrastar');

    it('is never disabled while the button is held, so the release is always reachable', () => {
      store.dragging.set(true);
      store.phase.set('offline');
      fixture.detectChanges();
      expect(dragButton().disabled).toBe(false);
      dragButton().click();
      expect(store.toggleDrag).toHaveBeenCalledTimes(1);
    });

    it('is disabled when nothing is held and the PC is away, like the other buttons', () => {
      store.phase.set('offline');
      fixture.detectChanges();
      expect(dragButton().disabled).toBe(true);
    });
  });

  describe('settings', () => {
    const gear = () => root.querySelector<HTMLButtonElement>('.settings')!;
    const sheet = () => root.querySelector<HTMLDialogElement>('dialog');
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it('the corner button is outside the surface, so touching it never starts a gesture', () => {
      expect(gear().getAttribute('aria-label')).toBe('Ajustes do touchpad');
      expect(pad().contains(gear())).toBe(false);
      gear().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      expect(store.beginGesture).not.toHaveBeenCalled();
    });

    it('opens the sheet and closes it again', async () => {
      expect(sheet()).toBeNull();
      gear().click();
      await settle();
      expect(sheet()?.hasAttribute('open')).toBe(true);
      root.querySelector<HTMLButtonElement>('dialog .footer button')!.click();
      await settle();
      expect(sheet()).toBeNull();
    });

    it('one touch on the corner button reaches the sensitivity, with the rest behind More settings', async () => {
      gear().click();
      await settle();
      expect(root.querySelector('dialog #pad-sensitivity')).not.toBeNull();
      expect(root.querySelector('dialog #scroll-sensitivity')).not.toBeNull();
      const more = [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
        (item) => item.textContent?.trim() === 'Mais ajustes',
      );
      expect(more).toBeTruthy();
    });
  });

  describe('the echo of what is typed', () => {
    const bar = (name: string) =>
      root.querySelector<HTMLButtonElement>(`app-pc-action-bar button[aria-label="${name}"]`)!;
    const field = () => root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
    const echo = () => root.querySelector<HTMLElement>('.echo');
    const line = () => root.querySelector<HTMLElement>('.echo-line');
    const toggle = () => root.querySelector<HTMLButtonElement>('.echo-toggle')!;
    const flush = async () => {
      for (let round = 0; round < 8; round++) await Promise.resolve();
    };
    const type = (text: string) => {
      field().value = field().value + text;
      field().dispatchEvent(new Event('input', { bubbles: true }));
    };

    it('appears above the bar only while typing, and shows the text and the keys', async () => {
      expect(echo()).toBeNull();
      bar('Teclado').click();
      fixture.detectChanges();
      // Nada digitado ainda: nada a mostrar.
      expect(echo()).toBeNull();
      type('oi');
      await flush();
      bar('Enter').click();
      fixture.detectChanges();
      expect(line()?.querySelector('.echo-text')?.textContent).toBe('oi');
      expect(line()?.querySelector('.echo-key')?.textContent).toBe('⏎');
      // Não é região viva: o leitor de tela não lê cada letra (pode ser uma senha).
      expect(echo()?.closest('[aria-live], [role="status"], [role="log"]')).toBeNull();
      expect(line()?.hasAttribute('aria-live')).toBe(false);
    });

    it('goes away and is emptied when the keyboard closes', async () => {
      bar('Teclado').click();
      type('abc');
      await flush();
      fixture.detectChanges();
      expect(line()?.textContent).toContain('abc');
      bar('Teclado').click();
      fixture.detectChanges();
      expect(echo()).toBeNull();
      bar('Teclado').click();
      fixture.detectChanges();
      expect(echo()).toBeNull();
    });

    it('one touch hides it without closing the phone keyboard, and the choice is kept', async () => {
      bar('Teclado').click();
      type('abc');
      await flush();
      fixture.detectChanges();
      expect(toggle().getAttribute('aria-label')).toBe('Esconder o que digito');
      toggle().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      field().blur();
      toggle().click();
      fixture.detectChanges();
      expect(document.activeElement).toBe(field());
      expect(line()).toBeNull();
      expect(prefs.showTyped()).toBe(false);
      // Escondido, só o botão de mostrar fica, e o texto não aparece em lugar nenhum.
      expect(toggle().getAttribute('aria-label')).toBe('Mostrar o que digito');
      expect(root.textContent).not.toContain('abc');
      toggle().click();
      fixture.detectChanges();
      expect(line()?.textContent).toContain('abc');
    });
  });

  describe('action bar and key panel', () => {
    const bar = (name: string) =>
      root.querySelector<HTMLButtonElement>(`app-pc-action-bar button[aria-label="${name}"]`)!;
    const panelKey = (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('app-pc-key-panel button')].find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
      )!;
    const settle = () => fixture.detectChanges();
    /** As teclas saem em fila, uma por vez: deixa a resposta de cada uma voltar. */
    const flush = async () => {
      for (let round = 0; round < 8; round++) await Promise.resolve();
    };

    it('Enter, Esc and Tab are one touch away from the surface', async () => {
      bar('Enter').click();
      await flush();
      bar('Esc (Escape)').click();
      await flush();
      bar('Tab').click();
      await flush();
      expect(store.sendKey.mock.calls).toEqual([
        ['ENTER', []],
        ['ESCAPE', []],
        ['TAB', []],
      ]);
    });

    it('Backspace acts on touch, and a keyboard activation acts once', () => {
      bar('Apagar').dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
      expect(store.sendKey.mock.calls).toEqual([['BACKSPACE', []]]);
      // O clique que o dedo gera depois do toque (detail 1) não repete a ação.
      bar('Apagar').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
      expect(store.sendKey).toHaveBeenCalledTimes(1);
    });

    it('holding Backspace repeats, but never queues more than two keys while none is answered', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        let answer!: () => void;
        store.sendKey.mockImplementation(
          () => new Promise((resolve) => (answer = () => resolve(null))),
        );
        bar('Apagar').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(store.sendKey).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(420);
        vi.advanceTimersByTime(3_000);
        bar('Apagar').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        // Uma tecla em voo e uma na fila: o resto das repetições pulou a rodada.
        answer();
        await flush();
        answer();
        await flush();
        expect(store.sendKey).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the panel opens over the surface, arms a key, and the next key carries it and lets go', () => {
      expect(root.querySelector('app-pc-key-panel')).toBeNull();
      bar('Mais teclas').click();
      settle();
      expect(bar('Mais teclas').getAttribute('aria-expanded')).toBe('true');
      panelKey('Ctrl').click();
      settle();
      expect(panelKey('Ctrl').getAttribute('aria-pressed')).toBe('true');
      expect(root.querySelector('.armed')?.textContent).toContain('Ctrl');

      bar('Tab').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('TAB', ['CTRL']);
      settle();
      expect(root.querySelector('.armed')).toBeNull();
      expect(panelKey('Ctrl').getAttribute('aria-pressed')).toBe('false');
    });

    it('the panel has navigation keys and the function row opens on Fn', async () => {
      bar('Mais teclas').click();
      settle();
      panelKey('Seta para cima').dispatchEvent(
        new MouseEvent('click', { detail: 0, bubbles: true }),
      );
      await flush();
      panelKey('Home (início da linha)').dispatchEvent(
        new MouseEvent('click', { detail: 0, bubbles: true }),
      );
      await flush();
      expect(store.sendKey.mock.calls).toEqual([
        ['UP', []],
        ['HOME', []],
      ]);
      expect(panelKey('F5')).toBeUndefined();
      panelKey('Fn').click();
      settle();
      panelKey('F5').click();
      await flush();
      expect(store.sendKey).toHaveBeenLastCalledWith('F5', []);
      bar('Mais teclas').click();
      settle();
      expect(root.querySelector('app-pc-key-panel')).toBeNull();
    });

    it('the panel keys carry the armed keys from the shared owner', () => {
      TestBed.inject(PcArmed).toggle('ALT');
      bar('Mais teclas').click();
      settle();
      panelKey('Fn').click();
      settle();
      panelKey('F4').click();
      expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('F4', ['ALT']);
    });

    it('shows the failure of a key for a moment', async () => {
      store.sendKey.mockResolvedValueOnce({ kind: 'offline', message: 'O PC está desconectado.' });
      bar('Enter').click();
      await flush();
      settle();
      expect(root.querySelector('.toast.ui-notice.bad')?.getAttribute('role')).toBe('alert');
      expect(root.querySelector('.toast')?.textContent).toContain('O PC está desconectado.');
    });

    it('one notice at a time: this one is the newest while shown, and a new failure of the module replaces it', async () => {
      // A falha que a casca já contava continua a mesma: o aviso desta tela (mais novo) fica, e a casca esconde o dela.
      store.notice.set({ kind: 'offline', message: 'O PC está desconectado.' });
      store.sendKey.mockResolvedValueOnce({ kind: 'offline', message: 'O PC está desconectado.' });
      bar('Enter').click();
      await flush();
      settle();
      expect(root.querySelectorAll('.toast')).toHaveLength(1);
      expect(fixture.componentInstance.toastShown()).toBe(true);
      // Uma falha nova da casca (no mesmo lugar, acima da barra) tira o desta tela: nada empilhado.
      store.notice.set({ kind: 'timeout', message: 'O PC não respondeu a tempo.' });
      settle();
      expect(root.querySelectorAll('.toast')).toHaveLength(0);
      expect(fixture.componentInstance.toastShown()).toBe(false);
    });

    it('a typed text that may have been lost says so, and a key that timed out leaves it to the failure notice', async () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      store.sendText.mockResolvedValueOnce({
        kind: 'timeout',
        message: 'O PC não respondeu a tempo.',
      });
      field.value += 'oi';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      settle();
      expect(root.querySelector('.toast')?.textContent).toContain(
        'Parte do texto pode não ter chegado.',
      );

      store.sendKey.mockResolvedValueOnce({
        kind: 'timeout',
        message: 'O PC não respondeu a tempo.',
      });
      bar('Enter').click();
      await flush();
      expect(store.sendKey).toHaveBeenCalled();
    });

    it('with the PC away the bar stays drawn but off, and sends nothing', () => {
      store.phase.set('offline');
      settle();
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('app-pc-action-bar button')];
      expect(buttons).toHaveLength(7);
      expect(buttons.every((b) => b.disabled)).toBe(true);
    });

    it('the keyboard button opens the phone keyboard on the hidden field and closes it again', () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('false');
      bar('Teclado').click();
      expect(document.activeElement).toBe(field);
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('true');
      bar('Teclado').click();
      settle();
      expect(document.activeElement).not.toBe(field);
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('false');
    });

    it('touching a key of the bar keeps the phone keyboard open', () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      bar('Teclado').click();
      // O toque na tecla avisa antes de o foco sair, e o clique o devolve.
      bar('Tab').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      field.blur();
      bar('Tab').click();
      expect(document.activeElement).toBe(field);
      // Fechado de propósito, tocar numa tecla não o reabre.
      bar('Teclado').click();
      expect(document.activeElement).not.toBe(field);
      bar('Tab').click();
      expect(document.activeElement).not.toBe(field);
    });

    it('the keyboard button closes the keyboard even if the touch took the focus away first', () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      bar('Teclado').click();
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('true');
      // Android: o toque tira o foco do campo antes do clique.
      bar('Teclado').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      field.blur();
      bar('Teclado').click();
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).not.toBe(field);
    });

    it('the pointerdown of the keyboard button is not left to the browser (it would move the focus)', () => {
      const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      bar('Teclado').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('when the system closes the keyboard, the button goes back to normal and a bar key does not reopen it', () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      bar('Teclado').click();
      settle();
      field.blur();
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('false');
      bar('Tab').click();
      expect(document.activeElement).not.toBe(field);
    });

    it('opening the shortcuts sheet or the settings closes the keyboard mode', async () => {
      bar('Teclado').click();
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('true');
      bar('Atalhos').click();
      await fixture.whenStable();
      settle();
      expect(bar('Teclado').getAttribute('aria-pressed')).toBe('false');
    });

    it('with the keyboard open, the armed keys get a row above the bar', () => {
      expect(root.querySelector('app-pc-action-bar .mods')).toBeNull();
      bar('Teclado').click();
      settle();
      const mods = [...root.querySelectorAll<HTMLButtonElement>('app-pc-action-bar .mods button')];
      expect(mods.map((b) => b.textContent?.trim())).toEqual(['Ctrl', 'Shift', 'Alt', 'Win']);
      mods[0].click();
      settle();
      expect(mods[0].getAttribute('aria-pressed')).toBe('true');
      expect(root.querySelector('.armed')?.textContent).toContain('Ctrl');
    });

    it('typing on the phone keyboard reaches the PC at once', () => {
      const field = root.querySelector<HTMLTextAreaElement>('app-pc-live-keyboard textarea')!;
      field.value += 'ok';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      expect(store.sendText).toHaveBeenCalledExactlyOnceWith('ok');
    });

    it('the shortcuts button opens the shortcuts sheet over the mouse, and the sheet closes again', async () => {
      expect(root.querySelector('app-pc-shortcut-sheet')).toBeNull();
      bar('Atalhos').click();
      await fixture.whenStable();
      settle();
      expect(bar('Atalhos').getAttribute('aria-expanded')).toBe('true');
      const dialog = root.querySelector('app-pc-shortcut-sheet dialog')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      root
        .querySelector<HTMLButtonElement>('app-pc-shortcut-sheet [data-shortcut="copy"]')!
        .click();
      await flush();
      expect(store.sendKey).toHaveBeenCalledWith('C', ['CTRL']);
      expect(root.querySelector('app-pc-shortcut-sheet dialog')?.hasAttribute('open')).toBe(true);
      root
        .querySelector<HTMLButtonElement>('app-pc-shortcut-sheet button[aria-label="Fechar"]')!
        .click();
      settle();
      await fixture.whenStable();
      settle();
      expect(root.querySelector('app-pc-shortcut-sheet')).toBeNull();
    });
  });

  describe('first-use hint and optional buttons', () => {
    it('draws the three gestures until the first touch, and never again', () => {
      prefs.set({ hintSeen: false });
      fixture.detectChanges();
      expect(root.querySelectorAll('.hints svg')).toHaveLength(3);
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerup', 1, 100, 100, 50);
      fixture.detectChanges();
      expect(root.querySelector('.hints')).toBeNull();
      expect(prefs.hintSeen()).toBe(true);
    });

    it('has no Left and Right buttons unless the person turns them on', () => {
      expect(root.querySelector('.buttons')).not.toBeNull();
      prefs.set({ clickButtons: false });
      fixture.detectChanges();
      expect(root.querySelector('.buttons')).toBeNull();
    });

    it('fills the screen: the shell reads this from the page', () => {
      expect(fixture.componentInstance.fillsScreen).toBe(true);
    });
  });

  describe('smart gestures', () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextFrame: number;

    beforeEach(() => {
      frames = new Map();
      nextFrame = 1;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(nextFrame, callback);
        return nextFrame++;
      });
      vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        frames.delete(handle);
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(window, 'matchMedia');
    });

    /**
     * Roda os quadros de animação pedidos até agora, 16 ms depois uns dos outros. O Angular também pede quadros: o que conta é
     * se a rolagem foi enviada ao PC (ou não).
     */
    let clock = 1_000;
    function runFrames(rounds = 1) {
      for (let round = 0; round < rounds; round++) {
        clock += 16;
        const due = [...frames];
        frames.clear();
        for (const [, callback] of due) callback(clock);
      }
    }

    /** Dois dedos que sobem andando rápido: a rolagem sai com velocidade. */
    function flick() {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 0);
      let y = 100;
      let time = 0;
      for (let step = 0; step < 6; step++) {
        y += 32;
        time += 16;
        pointer('pointermove', 1, 100, y, time);
        pointer('pointermove', 2, 140, y, time);
      }
      pointer('pointerup', 1, 100, y, time + 4);
      pointer('pointerup', 2, 140, y, time + 4);
    }

    it('a quick flick of two fingers keeps scrolling after they leave, a frame at a time', () => {
      flick();
      store.scrollPointer.mockClear();
      runFrames(2);
      expect(store.scrollPointer).toHaveBeenCalledTimes(2);
      const [dx, dy, dt] = store.scrollPointer.mock.calls[0];
      expect(dx).toBe(0);
      expect(dy).toBeGreaterThan(0);
      expect(dt).toBe(16);
    });

    it('a slow exit does not glide', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 0);
      pointer('pointermove', 1, 100, 120, 100);
      pointer('pointermove', 2, 140, 120, 100);
      pointer('pointerup', 1, 100, 120, 104);
      pointer('pointerup', 2, 140, 120, 104);
      store.scrollPointer.mockClear();
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('a new touch stops the glide at once', () => {
      flick();
      store.scrollPointer.mockClear();
      pointer('pointerdown', 1, 100, 100, 5_000);
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    describe('the touch that stops a glide', () => {
      beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
      afterEach(() => vi.useRealTimers());

      it('does not click when it lifts, not even a quick tap', () => {
        flick();
        store.click.mockClear();
        pointer('pointerdown', 1, 100, 100, 5_000);
        pointer('pointerup', 1, 100, 100, 5_050);
        expect(store.click).not.toHaveBeenCalled();
        expect(store.beginGesture).toHaveBeenCalledTimes(1);
      });

      it('does not start a long press if the finger stays', () => {
        flick();
        store.startDrag.mockClear();
        pointer('pointerdown', 1, 100, 100, 5_000);
        vi.advanceTimersByTime(2_000);
        expect(store.startDrag).not.toHaveBeenCalled();
        pointer('pointerup', 1, 100, 100, 7_000);
        expect(store.release).not.toHaveBeenCalled();
      });

      it('does not move the pointer or scroll if the finger walks', () => {
        flick();
        store.movePointer.mockClear();
        store.scrollPointer.mockClear();
        pointer('pointerdown', 1, 100, 100, 5_000);
        pointer('pointermove', 1, 200, 100, 5_016);
        pointer('pointerup', 1, 200, 100, 5_032);
        expect(store.movePointer).not.toHaveBeenCalled();
        expect(store.scrollPointer).not.toHaveBeenCalled();
      });

      it('swallows a second finger that lands with it, and the next touch is normal again', () => {
        flick();
        store.click.mockClear();
        pointer('pointerdown', 1, 100, 100, 5_000);
        pointer('pointerdown', 2, 140, 100, 5_005);
        pointer('pointerup', 1, 100, 100, 5_050);
        pointer('pointerup', 2, 140, 100, 5_055);
        expect(store.click).not.toHaveBeenCalled();
        pointer('pointerdown', 1, 100, 100, 6_000);
        pointer('pointerup', 1, 100, 100, 6_050);
        expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
      });

      it('a touch on a glide that has almost stopped (old and slow) is an ordinary tap', () => {
        const now = vi.spyOn(performance, 'now');
        now.mockReturnValue(1_000);
        flick();
        store.click.mockClear();
        // Passado o começo e já devagar: a página parou aos olhos da pessoa.
        now.mockReturnValue(1_000 + 900);
        for (let step = 0; step < 60; step++) runFrames();
        pointer('pointerdown', 1, 100, 100, 9_000);
        pointer('pointerup', 1, 100, 100, 9_050);
        expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
        now.mockRestore();
      });

      it('a touch on a glide that is still fast, even after the first moments, is only a stop', () => {
        const now = vi.spyOn(performance, 'now');
        now.mockReturnValue(1_000);
        flick();
        store.click.mockClear();
        now.mockReturnValue(1_000 + 900);
        runFrames();
        pointer('pointerdown', 1, 100, 100, 9_000);
        pointer('pointerup', 1, 100, 100, 9_050);
        expect(store.click).not.toHaveBeenCalled();
        now.mockRestore();
      });

      it('a touch when nothing was gliding is an ordinary tap', () => {
        pointer('pointerdown', 1, 100, 100, 0);
        pointer('pointerup', 1, 100, 100, 50);
        expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
      });

      it('a system cancel forgets the swallowed finger', () => {
        flick();
        store.click.mockClear();
        pointer('pointerdown', 1, 100, 100, 5_000);
        pointer('pointercancel', 1, 100, 100, 5_010);
        pointer('pointerdown', 1, 100, 100, 6_000);
        pointer('pointerup', 1, 100, 100, 6_050);
        expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
      });
    });

    it('hiding the page stops it', () => {
      flick();
      store.scrollPointer.mockClear();
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      runFrames(3);
      Reflect.deleteProperty(document, 'visibilityState');
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('pagehide stops it', () => {
      flick();
      store.scrollPointer.mockClear();
      window.dispatchEvent(new Event('pagehide'));
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('leaving the screen stops it', () => {
      flick();
      store.scrollPointer.mockClear();
      fixture.destroy();
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('the PC going away stops it, and no frame sends anything', () => {
      flick();
      store.scrollPointer.mockClear();
      store.phase.set('offline');
      fixture.detectChanges();
      TestBed.tick();
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('does not exist for someone who asked to reduce motion', () => {
      Object.defineProperty(window, 'matchMedia', {
        value: () => ({ matches: true }),
        configurable: true,
      });
      flick();
      store.scrollPointer.mockClear();
      runFrames(3);
      expect(store.scrollPointer).not.toHaveBeenCalled();
    });

    it('three fingers tapping click with the middle button', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 5);
      pointer('pointerdown', 3, 180, 100, 10);
      pointer('pointerup', 1, 100, 100, 70);
      pointer('pointerup', 2, 140, 100, 75);
      pointer('pointerup', 3, 180, 100, 80);
      expect(store.click).toHaveBeenCalledExactlyOnceWith('MIDDLE');
    });

    it('the middle click can be turned off in the settings', () => {
      prefs.set({ middleClick: false });
      TestBed.tick();
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 5);
      pointer('pointerdown', 3, 180, 100, 10);
      pointer('pointerup', 1, 100, 100, 70);
      pointer('pointerup', 2, 140, 100, 75);
      pointer('pointerup', 3, 180, 100, 80);
      expect(store.click).not.toHaveBeenCalled();
    });

    it('a tap draws a ring where the finger was, and it goes away by itself', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        vi.spyOn(pad(), 'getBoundingClientRect').mockReturnValue({
          left: 10,
          top: 20,
        } as DOMRect);
        pointer('pointerdown', 1, 110, 220, 0);
        pointer('pointerup', 1, 110, 220, 60);
        fixture.detectChanges();
        const ring = root.querySelector<HTMLElement>('.ring')!;
        expect(ring.dataset['kind']).toBe('left');
        expect(ring.getAttribute('aria-hidden')).toBe('true');
        expect(ring.style.left).toBe('100px');
        expect(ring.style.top).toBe('200px');
        vi.advanceTimersByTime(600);
        fixture.detectChanges();
        expect(root.querySelector('.ring')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('two fingers draw the right ring, three the middle one', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointerdown', 2, 140, 100, 5);
      pointer('pointerup', 1, 100, 100, 60);
      pointer('pointerup', 2, 140, 100, 65);
      fixture.detectChanges();
      expect(root.querySelector<HTMLElement>('.ring')?.dataset['kind']).toBe('right');
    });

    it('a scroll or a move draws no ring', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      pointer('pointermove', 1, 160, 100, 16);
      pointer('pointerup', 1, 160, 100, 32);
      fixture.detectChanges();
      expect(root.querySelector('.ring')).toBeNull();
    });

    describe('double tap and drag', () => {
      beforeEach(() => {
        prefs.set({ doubleTapDrag: true });
        TestBed.tick();
      });

      it('the first tap clicks, the second touch walking presses the button, and lifting releases', () => {
        pointer('pointerdown', 1, 100, 100, 0);
        pointer('pointerup', 1, 100, 100, 60);
        expect(store.click).toHaveBeenCalledExactlyOnceWith('LEFT');
        pointer('pointerdown', 1, 102, 100, 200);
        pointer('pointermove', 1, 150, 100, 230);
        expect(store.startDrag).toHaveBeenCalledTimes(1);
        expect(store.movePointer).toHaveBeenCalledWith(48, 0, 30);
        pointer('pointerup', 1, 150, 100, 260);
        expect(store.release).toHaveBeenCalledExactlyOnceWith({ persistent: true });
        expect(store.click).toHaveBeenCalledTimes(1);
      });

      it('is off by default', () => {
        prefs.set({ doubleTapDrag: false });
        TestBed.tick();
        pointer('pointerdown', 1, 100, 100, 0);
        pointer('pointerup', 1, 100, 100, 60);
        pointer('pointerdown', 1, 102, 100, 200);
        pointer('pointermove', 1, 150, 100, 230);
        expect(store.startDrag).not.toHaveBeenCalled();
      });
    });
  });
});
