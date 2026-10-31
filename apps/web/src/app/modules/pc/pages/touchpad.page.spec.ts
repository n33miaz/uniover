import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
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
    expect(store.toggleDrag).toHaveBeenCalledTimes(1);
  });
});
