import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { TouchpadSurface } from './touchpad-surface';

describe('TouchpadSurface', () => {
  const canSend = signal(true);
  const inFlightKeys = signal(0);
  const sendKey = vi.fn<(key: string) => Promise<boolean>>();
  let root: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<TouchpadSurface>>;

  const pad = () => root.querySelector<HTMLElement>('.pad')!;
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const keys = () => sendKey.mock.calls.map(([key]) => key);

  function pointer(
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    x: number,
    y: number,
    timeStamp: number,
  ) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.assign(event, { pointerId: 1, isPrimary: true });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    pad().dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    canSend.set(true);
    inFlightKeys.set(0);
    sendKey.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [{ provide: TvStore, useValue: { canSend, inFlightKeys, sendKey } }],
    });
    fixture = TestBed.createComponent(TouchpadSurface);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('explains itself to a screen reader and points to the Buttons mode', () => {
    expect(pad().getAttribute('aria-labelledby')).toBe('pad-help');
    const help = root.querySelector('#pad-help')!.textContent ?? '';
    expect(help).toContain('Touchpad');
    expect(help).toContain('modo Botões');
  });

  it('a quick still tap sends OK', async () => {
    pointer('pointerdown', 100, 100, 1_000);
    pointer('pointerup', 100, 100, 1_120);
    await flush();
    expect(keys()).toEqual(['OK']);
  });

  it('a long touch sends nothing', async () => {
    pointer('pointerdown', 100, 100, 1_000);
    pointer('pointerup', 100, 100, 1_450);
    await flush();
    expect(keys()).toEqual([]);
  });

  it('a slide sends the arrow once and never an OK', async () => {
    pointer('pointerdown', 100, 100, 1_000);
    pointer('pointermove', 140, 102, 1_050);
    pointer('pointerup', 140, 102, 1_100);
    await flush();
    expect(keys()).toEqual(['RIGHT']);
  });

  it('holding the finger displaced repeats the arrow at the interval and stops on release', async () => {
    pointer('pointerdown', 100, 100, 0);
    pointer('pointermove', 100, 60, 10);
    await flush();
    expect(keys()).toEqual(['UP']);
    await vi.advanceTimersByTimeAsync(250);
    expect(keys()).toEqual(['UP', 'UP']);
    await vi.advanceTimersByTimeAsync(500);
    expect(keys()).toHaveLength(4);

    pointer('pointerup', 100, 60, 900);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(keys()).toHaveLength(4);
  });

  it('stops repeating when the finger comes back to the middle', async () => {
    pointer('pointerdown', 100, 100, 0);
    pointer('pointermove', 60, 100, 10);
    await flush();
    pointer('pointermove', 98, 100, 20);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(keys()).toEqual(['LEFT']);
  });

  it('a cancelled touch sends nothing', async () => {
    pointer('pointerdown', 100, 100, 0);
    pointer('pointercancel', 100, 100, 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keys()).toEqual([]);
  });

  it('works from the keyboard: Enter and Space are OK, the arrows are the arrows', async () => {
    const press = (key: string) =>
      pad().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press('Enter');
    press(' ');
    press('ArrowLeft');
    press('ArrowDown');
    await flush();
    expect(keys()).toEqual(['OK', 'OK', 'LEFT', 'DOWN']);
  });

  it('does nothing while the remote cannot send, and looks disabled', async () => {
    canSend.set(false);
    fixture.detectChanges();
    expect(pad().classList.contains('disabled')).toBe(true);
    pointer('pointerdown', 100, 100, 0);
    pointer('pointerup', 100, 100, 50);
    await flush();
    expect(keys()).toEqual([]);
  });

  it('stops the repetition when the screen goes away', async () => {
    pointer('pointerdown', 100, 100, 0);
    pointer('pointermove', 140, 100, 10);
    await flush();
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(keys()).toEqual(['RIGHT']);
  });
});
