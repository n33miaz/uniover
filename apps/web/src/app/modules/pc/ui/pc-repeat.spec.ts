import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BATCH_EVERY_MS, BATCH_MAX } from '../input/repeat-batcher';
import { PcRepeat, REPEAT_AFTER_MS, REPEAT_EVERY_MS } from './pc-repeat';

@Component({
  imports: [PcRepeat],
  template: `<button
    type="button"
    [attr.aria-label]="'teste'"
    (appPcRepeat)="fired.set(fired() + 1)"
    [repeatSkip]="skip"
  ></button>`,
})
class Host {
  readonly fired = signal(0);
  skipping = false;
  readonly skip = () => this.skipping;
}

@Component({
  imports: [PcRepeat],
  template: `<button
    type="button"
    [attr.aria-label]="'teste'"
    (appPcRepeat)="taps.set(taps() + 1)"
    [batched]="batched()"
    (repeatMany)="batches.update((list) => [...list, $event])"
    [repeatSkip]="skip"
  ></button>`,
})
class BatchedHost {
  readonly taps = signal(0);
  readonly batches = signal<readonly number[]>([]);
  readonly batched = signal(true);
  busy = false;
  readonly skip = () => this.busy;
}

describe('PcRepeat in batches (the PC understands pc.key.v2)', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<BatchedHost>>;
  let button: HTMLButtonElement;
  let host: BatchedHost;

  const press = () => button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  const release = (type = 'pointerup') =>
    button.dispatchEvent(new MouseEvent(type, { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fixture = TestBed.createComponent(BatchedHost);
    fixture.detectChanges();
    host = fixture.componentInstance;
    button = fixture.nativeElement.querySelector('button');
  });
  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('the touch acts once, then after the delay each round is one request with several repeats', () => {
    press();
    expect(host.taps()).toBe(1);
    vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS * 3);
    expect(host.taps()).toBe(1);
    expect(host.batches().length).toBe(3);
    expect(host.batches().every((count) => count >= 2 && count <= BATCH_MAX)).toBe(true);
    release();
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave'])(
    '%s stops it, and nothing goes out later',
    (type) => {
      press();
      vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS * 2);
      release(type);
      const sent = host.batches().length;
      vi.advanceTimersByTime(5_000);
      expect(host.batches().length).toBe(sent);
    },
  );

  it('lifting the finger before the delay sends no repeat at all, only the touch', () => {
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS - 1);
    release();
    vi.advanceTimersByTime(5_000);
    expect(host.taps()).toBe(1);
    expect(host.batches()).toEqual([]);
  });

  it('with the queue busy the repeats are kept, and the next free round sends them together', () => {
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS);
    host.busy = true;
    vi.advanceTimersByTime(BATCH_EVERY_MS * 6);
    expect(host.batches()).toEqual([]);
    host.busy = false;
    vi.advanceTimersByTime(BATCH_EVERY_MS);
    expect(host.batches()).toEqual([BATCH_MAX]);
    release();
  });

  it('leaving the screen stops it', () => {
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS);
    fixture.destroy();
    const sent = host.batches().length;
    vi.advanceTimersByTime(5_000);
    expect(host.batches().length).toBe(sent);
  });

  it('is decided at the touch: a PC that does not declare the capability keeps one action per round', () => {
    host.batched.set(false);
    fixture.detectChanges();
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + REPEAT_EVERY_MS * 2);
    expect(host.batches()).toEqual([]);
    expect(host.taps()).toBe(1 + 1 + 2);
    release();
  });
});

describe('PcRepeat', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let button: HTMLButtonElement;

  const press = () => button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  const release = (type = 'pointerup') =>
    button.dispatchEvent(new MouseEvent(type, { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    button = fixture.nativeElement.querySelector('button');
  });
  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('acts at the touch, then repeats after the delay while the finger stays', () => {
    press();
    expect(fixture.componentInstance.fired()).toBe(1);
    vi.advanceTimersByTime(REPEAT_AFTER_MS - 1);
    expect(fixture.componentInstance.fired()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(fixture.componentInstance.fired()).toBe(2);
    vi.advanceTimersByTime(REPEAT_EVERY_MS * 3);
    expect(fixture.componentInstance.fired()).toBe(5);
    release();
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave'])('%s stops the repetition', (type) => {
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + REPEAT_EVERY_MS);
    release(type);
    const count = fixture.componentInstance.fired();
    vi.advanceTimersByTime(5_000);
    expect(fixture.componentInstance.fired()).toBe(count);
  });

  it('a round marked to skip does not act, and the next one does', () => {
    press();
    vi.advanceTimersByTime(REPEAT_AFTER_MS);
    fixture.componentInstance.skipping = true;
    vi.advanceTimersByTime(REPEAT_EVERY_MS * 4);
    expect(fixture.componentInstance.fired()).toBe(2);
    fixture.componentInstance.skipping = false;
    vi.advanceTimersByTime(REPEAT_EVERY_MS);
    expect(fixture.componentInstance.fired()).toBe(3);
    release();
  });

  it('the activation without a pointer (keyboard, screen reader) acts once; the click after a touch does not repeat the action', () => {
    button.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
    expect(fixture.componentInstance.fired()).toBe(1);
    button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    expect(fixture.componentInstance.fired()).toBe(1);
  });

  it('the secondary mouse button does nothing, and the context menu is cancelled', () => {
    const down = new MouseEvent('pointerdown', { bubbles: true, button: 2 });
    Object.defineProperty(down, 'pointerType', { value: 'mouse' });
    button.dispatchEvent(down);
    expect(fixture.componentInstance.fired()).toBe(0);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('leaving the screen stops the repetition', () => {
    press();
    fixture.destroy();
    const count = fixture.componentInstance.fired();
    vi.advanceTimersByTime(5_000);
    expect(fixture.componentInstance.fired()).toBe(count);
  });
});
