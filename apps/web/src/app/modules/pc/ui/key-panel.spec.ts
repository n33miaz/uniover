import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PcKey } from '../data/pc-types';
import { BATCH_EVERY_MS } from '../input/repeat-batcher';
import { PcKeyPanel } from './key-panel';
import { REPEAT_AFTER_MS, REPEAT_EVERY_MS } from './pc-repeat';

@Component({
  imports: [PcKeyPanel],
  template: `<app-pc-key-panel
    [moreKeys]="more()"
    [batched]="batched()"
    [switching]="switching()"
    (key)="keys.push($event)"
    (keyRepeat)="repeats.push($event)"
    (switchWindow)="switched = switched + 1"
  />`,
})
class Host {
  readonly more = signal(false);
  readonly batched = signal(false);
  readonly switching = signal(false);
  readonly keys: PcKey[] = [];
  readonly repeats: { key: PcKey; count: number }[] = [];
  switched = 0;
}

describe('PcKeyPanel with the keys of pc.key.v2', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let host: Host;
  let root: HTMLElement;
  const toggle = () => root.querySelector<HTMLButtonElement>('[data-more-toggle]');
  const key = (code: string) => root.querySelector<HTMLButtonElement>(`[data-key="${code}"]`);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
    root = fixture.nativeElement;
  });
  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  const openMore = () => {
    host.more.set(true);
    fixture.detectChanges();
    toggle()!.click();
    fixture.detectChanges();
  };

  it('a PC without pc.key.v2 does not even see the button of the new keys, and keeps the navigation', () => {
    expect(toggle()).toBeNull();
    expect(key('HOME')).not.toBeNull();
    expect(root.querySelector('.more')).toBeNull();
  });

  it('with pc.key.v2 the button appears, and the navigation is replaced by the digits and the new keys', () => {
    host.more.set(true);
    fixture.detectChanges();
    expect(toggle()).not.toBeNull();
    expect(key('D0')).toBeNull();
    toggle()!.click();
    fixture.detectChanges();
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.nav')).toBeNull();
    const codes = [...root.querySelectorAll('.more [data-key]')].map((item) =>
      item.getAttribute('data-key'),
    );
    expect(codes).toEqual([
      'D1',
      'D2',
      'D3',
      'D4',
      'D5',
      'D6',
      'D7',
      'D8',
      'D9',
      'D0',
      'MINUS',
      'EQUALS',
      'COMMA',
      'PERIOD',
      'INSERT',
      'PRINT_SCREEN',
      'WIN',
      'CAPS_LOCK',
      'APPS',
    ]);
    toggle()!.click();
    fixture.detectChanges();
    expect(key('HOME')).not.toBeNull();
  });

  it('each new key sends its own code, as a single tap', () => {
    openMore();
    for (const code of [
      'D1',
      'D0',
      'MINUS',
      'EQUALS',
      'COMMA',
      'PERIOD',
      'INSERT',
      'PRINT_SCREEN',
      'WIN',
      'CAPS_LOCK',
      'APPS',
    ])
      key(code)!.click();
    expect(host.keys).toEqual([
      'D1',
      'D0',
      'MINUS',
      'EQUALS',
      'COMMA',
      'PERIOD',
      'INSERT',
      'PRINT_SCREEN',
      'WIN',
      'CAPS_LOCK',
      'APPS',
    ]);
  });

  it('the Win of the new keys is the key alone, named so, and not the armed Win', () => {
    openMore();
    expect(key('WIN')!.getAttribute('aria-label')).toBe('Tecla Windows (sozinha)');
    expect(root.querySelector('.mods')!.textContent).toContain('Win');
  });

  it('the "Alt+Tab" button emits switchWindow and shows pressed while the Alt is held', () => {
    openMore();
    const button = root.querySelector<HTMLButtonElement>('[data-switch-window]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(host.switched).toBe(1);
    host.switching.set(true);
    fixture.detectChanges();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('on')).toBe(true);
  });

  it('when the PC stops declaring the capability the panel goes back to the navigation by itself', () => {
    openMore();
    host.more.set(false);
    fixture.detectChanges();
    expect(toggle()).toBeNull();
    expect(root.querySelector('.more')).toBeNull();
    expect(key('HOME')).not.toBeNull();
  });

  it('holding an arrow on a PC with pc.key.v2 sends batches with a repeat count', () => {
    host.batched.set(true);
    fixture.detectChanges();
    const arrow = key('RIGHT')!;
    arrow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(host.keys).toEqual(['RIGHT']);
    vi.advanceTimersByTime(REPEAT_AFTER_MS + BATCH_EVERY_MS * 2);
    arrow.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(host.keys).toEqual(['RIGHT']);
    expect(host.repeats.length).toBe(2);
    expect(host.repeats.every((item) => item.key === 'RIGHT' && item.count >= 2)).toBe(true);
  });

  it('holding an arrow on an older PC repeats the single key, as before', () => {
    const arrow = key('DELETE')!;
    arrow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(REPEAT_AFTER_MS + REPEAT_EVERY_MS * 2);
    arrow.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(host.keys).toEqual(['DELETE', 'DELETE', 'DELETE', 'DELETE']);
    expect(host.repeats).toEqual([]);
  });
});
