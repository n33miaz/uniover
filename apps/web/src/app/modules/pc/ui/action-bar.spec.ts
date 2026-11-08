import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PcKey } from '../data/pc-types';
import { BATCH_EVERY_MS } from '../input/repeat-batcher';
import { PcActionBar } from './action-bar';
import { REPEAT_AFTER_MS, REPEAT_EVERY_MS } from './pc-repeat';

@Component({
  imports: [PcActionBar],
  template: `<app-pc-action-bar
    [batched]="batched()"
    (key)="keys.push($event)"
    (keyRepeat)="repeats.push($event)"
  />`,
})
class Host {
  readonly batched = signal(false);
  readonly keys: PcKey[] = [];
  readonly repeats: { key: PcKey; count: number }[] = [];
}

describe('PcActionBar Backspace held down', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let host: Host;
  let backspace: HTMLButtonElement;
  const down = () => backspace.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  const up = () => backspace.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
    backspace = fixture.nativeElement.querySelector('[aria-label="Apagar"]');
  });
  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('on a PC with pc.key.v2: one Backspace at the touch, then one request per round with a repeat count', () => {
    host.batched.set(true);
    fixture.detectChanges();
    down();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS * 4);
    up();
    expect(host.keys).toEqual(['BACKSPACE']);
    expect(host.repeats).toHaveLength(4);
    expect(host.repeats.every((item) => item.key === 'BACKSPACE' && item.count >= 2)).toBe(true);
  });

  it('letting go stops it: no request after the finger left', () => {
    host.batched.set(true);
    fixture.detectChanges();
    down();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS);
    up();
    const sent = host.repeats.length;
    vi.advanceTimersByTime(10_000);
    expect(host.repeats.length).toBe(sent);
  });

  it('on an older PC it falls back to the single-key repeat, request after request', () => {
    down();
    vi.advanceTimersByTime(REPEAT_AFTER_MS + REPEAT_EVERY_MS * 3);
    up();
    expect(host.keys).toEqual(['BACKSPACE', 'BACKSPACE', 'BACKSPACE', 'BACKSPACE', 'BACKSPACE']);
    expect(host.repeats).toEqual([]);
  });

  it('a single tap is one Backspace on both', () => {
    for (const batched of [false, true]) {
      host.batched.set(batched);
      fixture.detectChanges();
      host.keys.length = 0;
      down();
      up();
      expect(host.keys).toEqual(['BACKSPACE']);
      expect(host.repeats).toEqual([]);
    }
  });
});
