import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { LONG_PRESS_MS } from '../input/pad-gesture';
import { TouchpadPage } from './touchpad.page';

describe('TouchpadPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TouchpadPage>>;
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
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(TouchpadPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('explains itself to a screen reader and points to the buttons', () => {
    expect(pad().getAttribute('aria-labelledby')).toBe('pad-help');
    const help = root.querySelector('#pad-help')!.textContent ?? '';
    expect(help).toContain('Touchpad');
    expect(help).toContain('botões');
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

  describe('long press', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('a finger held still presses the left button and lifting it releases, with no click', () => {
      pointer('pointerdown', 1, 100, 100, 0);
      vi.advanceTimersByTime(599);
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
      expect(root.querySelector('.hint.second')).toBeNull();
      pointer('pointerup', 1, 100, 100, 800);
      fixture.detectChanges();
      expect(pad().classList.contains('holding')).toBe(false);
      expect(root.querySelector('.holding-label')?.textContent?.trim()).toBe('');
      expect(root.querySelector('.hint.second')).not.toBeNull();
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
  });
});
