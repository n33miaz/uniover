import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
