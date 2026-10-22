import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { KeyButton, vibrate } from './key-button';

@Component({
  imports: [KeyButton],
  template: `
    <div id="up" [appKey]="'UP'" [repeat]="true"></div>
    <div id="ok" [appKey]="'OK'"></div>
  `,
})
class Host {}

describe('KeyButton', () => {
  const canSend = signal(true);
  const inFlightKeys = signal(0);
  const sendKey = vi.fn<(key: string) => Promise<boolean>>();
  let root: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;

  const up = () => root.querySelector<HTMLElement>('#up')!;
  const ok = () => root.querySelector<HTMLElement>('#ok')!;
  const flush = () => vi.advanceTimersByTimeAsync(0);

  function pointer(
    element: Element,
    type: 'pointerdown' | 'pointerup' | 'pointercancel',
    init: { pointerType?: string; button?: number } = {},
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: init.button ?? 0,
    });
    Object.assign(event, { pointerType: init.pointerType ?? 'touch', pointerId: 1 });
    element.dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    canSend.set(true);
    inFlightKeys.set(0);
    sendKey.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [{ provide: TvStore, useValue: { canSend, inFlightKeys, sendKey } }],
    });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('sends the key once on a click (keyboard and screen reader arrive this way)', async () => {
    ok().click();
    await flush();
    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('OK');
  });

  it('a touch sends the key once, on release (the click), not on press', async () => {
    pointer(up(), 'pointerdown');
    await flush();
    expect(sendKey).not.toHaveBeenCalled();
    pointer(up(), 'pointerup');
    up().click();
    await flush();
    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('UP');
  });

  it('a touch that turns into a swipe (cancelled) sends nothing, so paging never presses a key', async () => {
    pointer(ok(), 'pointerdown');
    pointer(ok(), 'pointercancel');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('holding a repeatable key sends at 400 ms and then every 250 ms, and the release click adds nothing', async () => {
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(399);
    expect(sendKey).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendKey).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(sendKey).toHaveBeenCalledTimes(2);

    pointer(up(), 'pointerup');
    up().click();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendKey).toHaveBeenCalledTimes(2);
  });

  it('a long press on a key that does not repeat sends it once, on release', async () => {
    pointer(ok(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendKey).not.toHaveBeenCalled();
    pointer(ok(), 'pointerup');
    ok().click();
    await flush();
    expect(sendKey).toHaveBeenCalledTimes(1);
  });

  it('stops repeating when a key fails, without looping', async () => {
    sendKey.mockResolvedValue(false);
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(400);
    expect(sendKey).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendKey).toHaveBeenCalledTimes(1);
  });

  it('lets a round pass when too many keys wait for an answer', async () => {
    inFlightKeys.set(3);
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendKey).not.toHaveBeenCalled();
    inFlightKeys.set(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(sendKey).toHaveBeenCalledTimes(1);
  });

  it('does not let the repeat warning swallow the next tap', async () => {
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(500);
    expect(sendKey).toHaveBeenCalledTimes(1);
    pointer(up(), 'pointercancel'); // soltou sem clique
    await vi.advanceTimersByTimeAsync(600);

    up().click();
    await flush();
    expect(sendKey).toHaveBeenCalledTimes(2);
  });

  it('shows the pressed state while the finger is down', () => {
    pointer(ok(), 'pointerdown');
    fixture.detectChanges();
    expect(ok().classList.contains('pressed')).toBe(true);
    pointer(ok(), 'pointerup');
    fixture.detectChanges();
    expect(ok().classList.contains('pressed')).toBe(false);
  });

  it('is disabled, and does nothing, when the remote cannot send', async () => {
    canSend.set(false);
    fixture.detectChanges();
    expect(ok().hasAttribute('disabled')).toBe(true);
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendKey).not.toHaveBeenCalled();

    canSend.set(true);
    fixture.detectChanges();
    expect(ok().hasAttribute('disabled')).toBe(false);
  });

  it('ignores the right mouse button', async () => {
    pointer(up(), 'pointerdown', { pointerType: 'mouse', button: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('stops the repetition when the screen goes away', async () => {
    pointer(up(), 'pointerdown');
    await vi.advanceTimersByTimeAsync(400);
    expect(sendKey).toHaveBeenCalledTimes(1);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendKey).toHaveBeenCalledTimes(1);
  });
});

describe('vibrate', () => {
  const vibrateSpy = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vibrateSpy.mockReset();
    Object.defineProperty(navigator, 'vibrate', { value: vibrateSpy, configurable: true });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  it('gives a short vibration by default', () => {
    const prefs = TestBed.inject(TvPrefs);
    vibrate(prefs.vibration());
    expect(vibrateSpy).toHaveBeenCalledExactlyOnceWith(8);
  });

  it('stays quiet once the owner turns the vibration off in Personalizar, and comes back when turned on', () => {
    const prefs = TestBed.inject(TvPrefs);
    prefs.set({ vibration: false });
    vibrate(prefs.vibration());
    expect(vibrateSpy).not.toHaveBeenCalled();

    prefs.set({ vibration: true });
    vibrate(prefs.vibration());
    expect(vibrateSpy).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for who asked for less motion, even with the vibration on', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const prefs = TestBed.inject(TvPrefs);
    vibrate(prefs.vibration());
    expect(vibrateSpy).not.toHaveBeenCalled();
  });
});
