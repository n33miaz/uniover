import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { CANCELLED } from './pc-failure';
import { PcPrefs } from './pc-prefs';
import {
  DOWN_TIMEOUT_MS,
  HOLD_HEARTBEAT_MS,
  PC_POLL_MS,
  PcStore,
  UP_DRAIN_MS,
  UP_RETRY_BACKOFF_MS,
} from './pc-store';

function setup(initial: PcStatus | null = status()) {
  const current = signal<PcStatus | null>(initial);
  const availability = {
    status: current.asReadonly(),
    apps: () => current()?.apps ?? [],
    refresh: vi.fn(() => Promise.resolve(true)),
  };
  const api = {
    pointer: vi.fn(() => Promise.resolve()),
    click: vi.fn(() => Promise.resolve()),
    key: vi.fn(() => Promise.resolve()),
    text: vi.fn(() => Promise.resolve()),
    media: vi.fn(() => Promise.resolve()),
    power: vi.fn(() => Promise.resolve()),
    launch: vi.fn(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: availability },
      { provide: PcApi, useValue: api },
    ],
  });
  return { store: TestBed.inject(PcStore), api, availability, current };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function signIn(id: string) {
  TestBed.inject(SessionState).setUser({
    id,
    email: `${id}@exemplo.com`,
    displayName: id,
    role: 'owner',
  });
}

describe('PcStore phase', () => {
  it.each<[PcStatus | null, string, boolean]>([
    [null, 'loading', false],
    [status({ available: false, online: false }), 'unavailable', false],
    [status({ online: false }), 'offline', false],
    [status(), 'ready', true],
  ])('%j is %s', (current, phase, canSend) => {
    const { store } = setup(current);
    expect(store.phase()).toBe(phase);
    expect(store.canSend()).toBe(canSend);
  });

  it('follows the availability as it changes', () => {
    const { store, current } = setup(status({ online: false }));
    expect(store.phase()).toBe('offline');
    current.set(status());
    expect(store.phase()).toBe('ready');
  });
});

describe('PcStore commands', () => {
  it('sends text, keys, media, power and launches through the API and reports success as null', async () => {
    const { store, api } = setup();
    expect(await store.sendText('olá')).toBeNull();
    expect(await store.sendKey('C', ['CTRL'])).toBeNull();
    expect(await store.sendMedia('VOLUME_UP', 2)).toBeNull();
    expect(await store.power('SLEEP', true)).toBeNull();
    expect(await store.launch('notas')).toBeNull();
    expect(api.text).toHaveBeenCalledWith('olá');
    expect(api.key).toHaveBeenCalledWith('C', ['CTRL']);
    expect(api.media).toHaveBeenCalledWith('VOLUME_UP', 2);
    expect(api.power).toHaveBeenCalledWith('SLEEP', true);
    expect(api.launch).toHaveBeenCalledWith('notas');
  });

  it('sends nothing while the PC is not connected, and says why', async () => {
    const { store, api } = setup(status({ online: false }));
    expect((await store.sendKey('ENTER'))?.kind).toBe('offline');
    const { store: other, api: otherApi } = (() => {
      TestBed.resetTestingModule();
      return setup(status({ available: false, online: false }));
    })();
    expect((await other.sendText('x'))?.kind).toBe('unavailable');
    expect(api.key).not.toHaveBeenCalled();
    expect(otherApi.text).not.toHaveBeenCalled();
  });

  it('turns an API error into a short failure and re-reads the status when the PC went away', async () => {
    const { store, api, availability } = setup();
    api.key.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const failure = await store.sendKey('ENTER');
    expect(failure?.kind).toBe('offline');
    expect(store.notice()?.kind).toBe('offline');
    expect(availability.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the status for a failure that says nothing about the PC being away', async () => {
    const { store, api, availability } = setup();
    api.media.mockRejectedValueOnce(new HttpErrorResponse({ status: 429 }));
    expect((await store.sendMedia('MUTE'))?.kind).toBe('rate-limited');
    expect(availability.refresh).not.toHaveBeenCalled();
  });

  it('a click goes after the movement that was already on its way', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    let release = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('pointer done');
            resolve();
          };
        }),
    );
    api.click.mockImplementationOnce(() => {
      order.push('click');
      return Promise.resolve();
    });
    store.movePointer(10, 0, 16);
    const clicking = store.click('LEFT');
    await flush();
    expect(order).toEqual([]);
    release();
    await clicking;
    expect(order).toEqual(['pointer done', 'click']);
  });

  it('a click waits for every movement in flight and for the one still waiting for its slot', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    const finish: (() => void)[] = [];
    api.pointer.mockImplementation(((dx: number) => {
      order.push(`pointer ${dx}`);
      return new Promise<void>((resolve) => finish.push(resolve));
    }) as never);
    api.click.mockImplementationOnce(() => {
      order.push('click');
      return Promise.resolve();
    });
    store.movePointer(10, 0, 16); // sai já
    store.movePointer(7, 0, 16); // espera a taxa
    const clicking = store.click('LEFT');
    await flush();
    expect(order).toEqual(['pointer 10', 'pointer 7']);
    finish.forEach((resolve) => resolve());
    await clicking;
    expect(order).toEqual(['pointer 10', 'pointer 7', 'click']);
  });

  it('a second text only leaves after the first one settled, so they never swap on the way', async () => {
    const { store, api } = setup();
    let finishFirst: () => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    await flush();
    expect(api.text.mock.calls).toEqual([['abc']]);
    finishFirst();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(api.text.mock.calls).toEqual([['abc'], ['def']]);
  });

  it('a key never overtakes the text before it (Enter after a text goes after it)', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    let finishText: () => void = () => undefined;
    api.text.mockImplementationOnce(() => {
      order.push('text');
      return new Promise<void>((resolve) => (finishText = resolve));
    });
    api.key.mockImplementationOnce(() => {
      order.push('key');
      return Promise.resolve();
    });
    const text = store.sendText('senha');
    const key = store.sendKey('ENTER');
    await flush();
    expect(order).toEqual(['text']);
    finishText();
    await Promise.all([text, key]);
    expect(order).toEqual(['text', 'key']);
  });

  it('a failure cancels the texts and keys queued behind it, and the queue works again afterwards', async () => {
    const { store, api } = setup();
    let failFirst: (error: unknown) => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((_, reject) => (failFirst = reject)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    const third = store.sendKey('ENTER');
    await flush();
    failFirst(new HttpErrorResponse({ status: 503 }));
    expect((await first)?.kind).toBe('offline');
    expect(await second).toBe(CANCELLED);
    expect(await third).toBe(CANCELLED);
    expect(api.text.mock.calls).toEqual([['abc']]);
    expect(api.key).not.toHaveBeenCalled();

    // O que for pedido depois da falha já sai.
    expect(await store.sendText('ghi')).toBeNull();
    expect(api.text.mock.calls).toEqual([['abc'], ['ghi']]);
  });

  it('typed input is cancelled when the account changes while it waits', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishFirst: () => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishFirst();
    await first;
    expect(await second).toBe(CANCELLED);
    expect(api.text.mock.calls).toEqual([['abc']]);
  });

  it('numbers each movement request with a growing sequence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      const seqs = (api.pointer.mock.calls as unknown as number[][]).map((call) => call[4]);
      expect(seqs).toHaveLength(3);
      expect(seqs.every((seq) => typeof seq === 'number')).toBe(true);
      expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
      expect(new Set(seqs).size).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drag holds the left button and the next call releases it', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    await store.toggleDrag();
    expect(store.dragging()).toBe(false);
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
  });

  it('drag stays off when the button could not be pressed', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    expect((await store.toggleDrag())?.kind).toBe('timeout');
    expect(store.dragging()).toBe(false);
  });
});

describe('PcStore holding the button', () => {
  const failing = (status: number) => new HttpErrorResponse({ status });

  /** Um pedido que só termina quando o teste manda. */
  function hanging(mock: { mockImplementationOnce: (fn: () => Promise<void>) => unknown }) {
    let finish: () => void = () => undefined;
    mock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    return () => finish();
  }

  afterEach(() => vi.restoreAllMocks());

  it('a failed DOWN is followed by an UP right away, and the button is not shown as held', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(failing(504));
    expect((await store.toggleDrag())?.kind).toBe('timeout');
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
    expect(store.dragging()).toBe(false);
  });

  it('a DOWN that never answers is given up after the timeout and released', async () => {
    vi.useFakeTimers();
    try {
      const { store, api } = setup();
      hanging(api.click);
      const asking = store.toggleDrag();
      await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
      expect((await asking)?.kind).toBe('timeout');
      expect(api.click.mock.calls).toEqual([
        ['LEFT', 'DOWN'],
        ['LEFT', 'UP'],
      ]);
      expect(store.dragging()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second tap on Drag while the DOWN is on its way does not send another DOWN', async () => {
    const { store, api } = setup();
    const finish = hanging(api.click);
    const first = store.toggleDrag();
    const second = store.toggleDrag();
    const third = store.toggleDrag();
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'DOWN']]);
    finish();
    await Promise.all([first, second, third]);
    expect(store.dragging()).toBe(true);
    expect(api.click).toHaveBeenCalledTimes(1);
  });

  it('a tap while the UP is on its way is ignored too, and the next one starts again', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockClear();
    const finish = hanging(api.click);
    const releasing = store.toggleDrag();
    await flush();
    await store.toggleDrag();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    finish();
    await releasing;
    expect(store.dragging()).toBe(false);
    await store.toggleDrag();
    expect(api.click.mock.calls.at(-1)).toEqual(['LEFT', 'DOWN']);
  });

  it('a release asked while the DOWN is still leaving goes out as soon as the DOWN answers', async () => {
    const { store, api } = setup();
    const finish = hanging(api.click);
    const starting = store.startDrag();
    await flush();
    expect(await store.release()).toBeNull();
    expect(api.click.mock.calls).toEqual([['LEFT', 'DOWN']]);
    finish();
    await starting;
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
    expect(store.dragging()).toBe(false);
  });

  it('a release asked while the movement was still going out means the DOWN is not sent at all', async () => {
    const { store, api } = setup();
    const finishMove = hanging(api.pointer);
    store.movePointer(10, 0, 16);
    const starting = store.startDrag();
    await flush();
    await store.release();
    finishMove();
    expect(await starting).toBeNull();
    expect(store.dragging()).toBe(false);
    expect(api.click).not.toHaveBeenCalled();
  });

  it('the normal release waits for the movement in flight, so the drop happens where the finger ended', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockClear();
    const order: string[] = [];
    let finishMove: () => void = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishMove = () => {
            order.push('move done');
            resolve();
          };
        }),
    );
    api.click.mockImplementationOnce(() => {
      order.push('UP');
      return Promise.resolve();
    });
    store.movePointer(30, 0, 16);
    const releasing = store.release();
    await flush();
    expect(order).toEqual([]);
    finishMove();
    await releasing;
    expect(order).toEqual(['move done', 'UP']);
  });

  it('a movement request that never answers cannot keep the button pressed: the UP leaves after a limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      await store.toggleDrag();
      api.click.mockClear();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(30, 0, 16);
      const releasing = store.release();
      await vi.advanceTimersByTimeAsync(UP_DRAIN_MS - 1);
      expect(api.click).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await releasing;
      expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
      expect(store.dragging()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('release does nothing when no button is held', async () => {
    const { store, api } = setup();
    expect(await store.release()).toBeNull();
    expect(api.click).not.toHaveBeenCalled();
  });

  it('release works even when the PC is shown as disconnected (an extra UP is harmless)', async () => {
    const { store, api, current } = setup();
    await store.toggleDrag();
    current.set(status({ online: false }));
    api.click.mockClear();
    await store.release();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    expect(store.dragging()).toBe(false);
  });

  it('a release that fails keeps the button shown as held, so the person can try again', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(failing(503));
    expect((await store.release())?.kind).toBe('offline');
    expect(store.dragging()).toBe(true);
    await store.release();
    expect(store.dragging()).toBe(false);
  });

  it('pagehide releases the button with a keepalive request', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP', { keepalive: true }]]);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('going to the background (the page turns hidden) releases it too', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP', { keepalive: true }]]);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('hiding the page with nothing held sends nothing', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click).not.toHaveBeenCalled();
    stop();
  });

  it('hiding the page while the DOWN is on its way sends no UP out of the queue: the keepalive UP follows right after the DOWN settled', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    const log: string[] = [];
    let finish: () => void = () => undefined;
    api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finish = () => {
            log.push('DOWN settled');
            resolve();
          };
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    const starting = store.startDrag();
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(log).toEqual(['DOWN sent']);
    finish();
    await starting;
    await flush();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('if the release on hide does not get through, the button stays shown as held', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(failing(503));
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(store.dragging()).toBe(true);
    stop();
  });

  it('closing the watch (leaving the module) releases the button', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    stop();
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    expect(store.dragging()).toBe(false);
  });

  it('stops listening once the watch is closed', async () => {
    const { store, api } = setup();
    store.watch()();
    await store.toggleDrag();
    api.click.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click).not.toHaveBeenCalled();
  });
});

describe('PcStore pointer preferences', () => {
  it('moves the pointer one for one by default, at any speed', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.movePointer(40, 0, 4);
    await flush();
    expect(api.pointer).toHaveBeenCalledWith(40, 0, 0, 0, expect.any(Number));
  });

  it('uses the gain the person chose', async () => {
    const { store, api } = setup();
    TestBed.inject(PcPrefs).set({ sensitivity: 'high' });
    store.beginGesture();
    store.movePointer(10, 0, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledWith(16, 0, 0, 0, expect.any(Number));
  });

  it('scrolls the Windows way by default and the other way when inverted', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.scrollPointer(0, 20, 400);
    await flush();
    const natural = (api.pointer.mock.calls[0] as unknown as number[])[3];
    expect(natural).toBeLessThan(0);

    TestBed.inject(PcPrefs).set({ invertScroll: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.beginGesture();
    store.scrollPointer(0, 20, 400);
    await flush();
    const inverted = (api.pointer.mock.calls[1] as unknown as number[])[3];
    expect(inverted).toBe(-natural);
  });

  it('a faster swipe scrolls farther than the same swipe done slowly', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.scrollPointer(0, 40, 400);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.beginGesture();
    store.scrollPointer(0, 40, 20);
    await flush();
    const slow = (api.pointer.mock.calls[0] as unknown as number[])[3];
    const fast = (api.pointer.mock.calls[1] as unknown as number[])[3];
    expect(Math.abs(fast)).toBeGreaterThan(Math.abs(slow));
  });
});

describe('PcStore sign of life while the button is held', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  const beats = (api: ReturnType<typeof setup>['api']) =>
    (api.pointer.mock.calls as unknown[][]).filter(([dx, dy]) => dx === 0 && dy === 0).length;

  it('sends a zero movement every 10 s while the button is held, and nothing before it is', async () => {
    const { store, api } = setup();
    vi.advanceTimersByTime(HOLD_HEARTBEAT_MS * 2);
    expect(api.pointer).not.toHaveBeenCalled();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS - 1);
    expect(beats(api)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 2);
    expect(beats(api)).toBe(3);
  });

  it('the beat carries no scroll and moves nothing', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer.mock.calls).toEqual([[0, 0]]);
  });

  it('stops when the button is released', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('stops when the page is hidden, and comes back if the button is still held when it shows again', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 2);
    expect(beats(api)).toBe(0);
    expect(store.dragging()).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(1);
    stop();
  });

  it('stops when the module is left', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(beats(api)).toBe(0);
  });

  it('stops when the account changes', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(beats(api)).toBe(0);
  });

  it('stays quiet when a beat fails and tries again at the next one', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.pointer.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(store.notice()).toBeNull();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(2);
  });

  it('does not add a beat while real pointer traffic is on its way', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.pointer.mockImplementationOnce(() => new Promise<void>(() => undefined));
    store.movePointer(10, 0, 16);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledTimes(1);
  });
});

describe('PcStore button commands in order and without leftovers', () => {
  /** Um pedido que só termina quando o teste manda, com o que aconteceu anotado numa lista. */
  function logged(api: ReturnType<typeof setup>['api'], log: string[]) {
    const finishers: (() => void)[] = [];
    api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finishers.push(() => {
            log.push('DOWN settled');
            resolve();
          });
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    return { settleDown: () => finishers.shift()!() };
  }

  afterEach(() => vi.useRealTimers());

  it('an UP asked while the DOWN is still on its way waits for the DOWN to settle', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const starting = store.startDrag();
    await flush();
    await store.release();
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settleDown();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent']);
    expect(store.dragging()).toBe(false);
  });

  it('when the DOWN fails, the UP goes only after it settled', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    api.click.mockImplementation(((_button?: string, action?: string) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((_resolve, reject) =>
          setTimeout(() => {
            log.push('DOWN settled');
            reject(new HttpErrorResponse({ status: 503 }));
          }, 10),
        );
      }
      log.push('UP sent');
      return Promise.resolve();
    }) as never);
    await store.toggleDrag();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent']);
  });

  it('on the timeout the UP goes out, and if the DOWN answers OK later there is one more UP', async () => {
    vi.useFakeTimers();
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const starting = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    expect((await starting)?.kind).toBe('timeout');
    expect(log).toEqual(['DOWN sent', 'UP sent']);
    settleDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['DOWN sent', 'UP sent', 'DOWN settled', 'UP sent']);
    expect(store.dragging()).toBe(false);
  });

  it('a late DOWN does not release a new drag that started after the timeout', async () => {
    vi.useFakeTimers();
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const first = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    await first;
    const second = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(0);
    settleDown(); // o primeiro DOWN, atrasado
    await vi.advanceTimersByTimeAsync(0);
    settleDown(); // o segundo
    await second;
    expect(store.dragging()).toBe(true);
    expect(log.filter((entry) => entry === 'UP sent')).toHaveLength(1);
  });

  it('movement during a held-down press waits for the DOWN and then goes out', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    api.pointer.mockImplementation((() => {
      log.push('pointer');
      return Promise.resolve();
    }) as never);
    const starting = store.startDrag();
    await flush();
    store.beginGesture();
    store.movePointer(10, 0, 16);
    store.movePointer(5, 0, 16);
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settleDown();
    await starting;
    await flush();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'pointer']);
    expect(api.pointer).toHaveBeenCalledTimes(1);
    expect(store.dragging()).toBe(true);
  });
});

describe('PcStore after leaving the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const clickActions = (api: ReturnType<typeof setup>['api']) =>
    (api.click.mock.calls as unknown[][]).map(([, action]) => action);

  /** O DOWN fica no ar até o teste mandar; os UP seguem a regra dada. */
  function hangingDown(api: ReturnType<typeof setup>['api'], up: () => Promise<void>) {
    let finish: () => void = () => undefined;
    api.click.mockImplementation(((_button?: string, action?: string) =>
      action === 'DOWN'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : up()) as never);
    return () => finish();
  }

  it('leaving while the DOWN is on its way: a failing UP is retried, never re-marked as held, and no heartbeat leaks', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    const finish = hangingDown(api, () => Promise.reject(new HttpErrorResponse({ status: 503 })));
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await starting;
    expect(clickActions(api)).toEqual(['DOWN', 'UP', 'UP', 'UP']);
    expect(store.dragging()).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('the retry stops at the first UP that gets through', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    let attempts = 0;
    const finish = hangingDown(api, () =>
      ++attempts === 1 ? Promise.reject(new HttpErrorResponse({ status: 503 })) : Promise.resolve(),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS[0]);
    await starting;
    expect(clickActions(api)).toEqual(['DOWN', 'UP', 'UP']);
    expect(store.dragging()).toBe(false);
  });

  it('hiding the page while the DOWN is on its way: the UP that fails afterwards leaves no heartbeat either', async () => {
    const { store, api } = setup();
    store.watch();
    const finish = hangingDown(api, () => Promise.reject(new HttpErrorResponse({ status: 503 })));
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await starting;
    expect(store.dragging()).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('leaving with the button held and the UP failing keeps trying a few times, with no heartbeat', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(clickActions(api)).toEqual(['UP', 'UP', 'UP']);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('coming back to the screen allows the heartbeat again', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    stop();
    store.watch();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
  });
});

describe('PcStore when the account changes while a button is held', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const actions = (api: ReturnType<typeof setup>['api']) =>
    (api.click.mock.calls as unknown[][]).map(([, action]) => action);

  it('forgets the held button locally and sends nothing at all (the agent releases it by itself)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    api.click.mockClear();

    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);

    expect(store.dragging()).toBe(false);
    expect(api.click).not.toHaveBeenCalled();
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('a release retrying a failing UP gives up when the account changes during the wait', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    api.click.mockClear();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));

    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(actions(api)).toEqual(['UP']);
    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await releasing;
    expect(actions(api)).toEqual(['UP']);
  });

  it('the UP that follows a DOWN gives up when the account changed meanwhile', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    await store.release();
    signIn('conta-b');
    TestBed.tick();
    finish();
    await starting;
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(actions(api)).toEqual(['DOWN']);
  });

  it('the extra UP after a late DOWN is not sent once the account is another', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    await starting;
    expect(actions(api)).toEqual(['DOWN', 'UP']);
    signIn('conta-b');
    TestBed.tick();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions(api)).toEqual(['DOWN', 'UP']);
  });
});

describe('PcStore after a press that failed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('DOWN fails and the safety UP fails too: the release when the finger lifts retries the UP until it gets through', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 })); // DOWN
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 })); // UP de segurança
    expect((await store.startDrag())?.kind).toBe('timeout');
    expect(store.dragging()).toBe(false);
    expect((api.click.mock.calls as unknown[][]).map(([, action]) => action)).toEqual([
      'DOWN',
      'UP',
    ]);

    // O dedo sobe: o botão pode estar apertado, então o soltar insiste (a primeira tentativa falha, a segunda passa).
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS[0]);
    expect(await releasing).toBeNull();
    expect((api.click.mock.calls as unknown[][]).map(([, action]) => action)).toEqual([
      'DOWN',
      'UP',
      'UP',
      'UP',
    ]);
    // Agora nada pode estar apertado: soltar de novo não manda nada.
    await store.release({ persistent: true });
    expect(api.click).toHaveBeenCalledTimes(4);
  });
});

describe('PcStore pagehide with the DOWN still in flight', () => {
  /** O DOWN fica no ar; tudo que sai é anotado na ordem. */
  function setupInFlight() {
    const ctx = setup();
    const log: string[] = [];
    let finish: () => void = () => undefined;
    ctx.api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finish = () => {
            log.push('DOWN settled');
            resolve();
          };
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    return { ...ctx, log, settle: () => finish() };
  }

  const pageHide = (persisted: boolean) =>
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

  it('a page that really dies (persisted false) also sends an immediate keepalive UP, besides the queued one', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    pageHide(false);
    await flush();
    expect(log).toEqual(['DOWN sent', 'UP sent (keepalive)']);
    settle();
    await starting;
    await flush();
    expect(log).toEqual([
      'DOWN sent',
      'UP sent (keepalive)',
      'DOWN settled',
      'UP sent (keepalive)',
    ]);
    stop();
  });

  it('a page that goes to the cache (persisted true) only queues the UP after the DOWN', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    pageHide(true);
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settle();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    stop();
  });

  it('going to the background (visibilitychange) keeps only the queued UP', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settle();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    vi.restoreAllMocks();
    stop();
  });
});

describe('PcStore commands that give up because the account changed', () => {
  afterEach(() => localStorage.clear());

  it('an UP already waiting in the queue is dropped when the account changed before its turn, with no notice and no re-read of the state', async () => {
    const { store, api, availability } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    api.click.mockClear();
    availability.refresh.mockClear();

    // Algo na frente da fila segura a vez do UP (um pedido anterior ainda em voo).
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const releasing = store.release();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    await releasing;
    await flush();

    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
    expect(availability.refresh).not.toHaveBeenCalled();
  });

  it('a DOWN waiting in the queue gives up the same way', async () => {
    const { store, api, availability } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const starting = store.startDrag();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    await starting;
    await flush();
    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
    expect(availability.refresh).not.toHaveBeenCalled();
    expect(store.dragging()).toBe(false);
  });
});

describe('PcStore heartbeat when coming back to the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a button still held when the screen opens again gets its sign of life back', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(store.dragging()).toBe(true);
    api.pointer.mockClear();

    store.watch();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
  });
});

describe('PcStore heartbeat and the account', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('a tick never goes out when the session is already another account (before the store noticed)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    // Sem esperar o efeito da troca de conta: logo depois de entrar com a outra, o botão ainda consta como apertado, e é a
    // conferência do próprio sinal que o impede de ir para o PC errado.
    signIn('conta-b');
    expect(store.dragging()).toBe(true);
    await (store as unknown as { beat(): Promise<void> }).beat();
    expect(api.pointer).not.toHaveBeenCalled();
  });
});

describe('PcStore giving up quietly', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('an UP that gives up because the account changed leaves the retry loop at once, with a neutral value and no wait', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    api.click.mockClear();

    // O primeiro UP está na fila atrás de algo em voo; a conta muda antes de a vez dele chegar.
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(0);
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    // Nenhuma espera de retry: a promessa resolve sem avançar o relógio.
    const result = await releasing;
    expect(result?.kind).toBe('cancelled');
    expect(result?.message).toBe('');
    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
  });

  it('a command that gives up reports the neutral value, never a misleading message', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    expect(await starting).toBe(CANCELLED);
    expect(api.click).not.toHaveBeenCalled();
  });
});

describe('PcStore pointer', () => {
  it('accelerates the swipe and sends it as one request', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.movePointer(10, 4, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledTimes(1);
    const [dx, dy] = api.pointer.mock.calls[0] as unknown as number[];
    expect(dx).toBeGreaterThanOrEqual(10);
    expect(dy).toBeGreaterThanOrEqual(4);
  });

  it('turns a two-finger swipe into wheel units (down scrolls down)', async () => {
    const { store, api } = setup();
    store.scrollPointer(0, 40, 4_000);
    await flush();
    const [, , , scrollY] = api.pointer.mock.calls[0] as unknown as number[];
    expect(scrollY).toBeLessThanOrEqual(-120);
    expect(scrollY).toBeGreaterThan(-130);
  });

  it('sends nothing while the PC is not connected', async () => {
    const { store, api } = setup(status({ online: false }));
    store.movePointer(50, 50, 16);
    store.scrollPointer(0, 50);
    await flush();
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('shows the failure of a movement and clears it at the next success', async () => {
    const { store, api } = setup();
    api.pointer.mockRejectedValueOnce(new HttpErrorResponse({ status: 429 }));
    store.movePointer(5, 5, 16);
    await flush();
    expect(store.notice()?.kind).toBe('rate-limited');
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.movePointer(5, 5, 16);
    await flush();
    expect(store.notice()).toBeNull();
  });
});

describe('PcStore watch', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('reads the status now and then every poll interval, until stopped', () => {
    const { store, availability } = setup();
    const stop = store.watch();
    expect(availability.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PC_POLL_MS * 2);
    expect(availability.refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(PC_POLL_MS * 3);
    expect(availability.refresh).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden', () => {
    const { store, availability } = setup();
    const stop = store.watch();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(PC_POLL_MS * 2);
    expect(availability.refresh).toHaveBeenCalledTimes(1);
    stop();
    vi.restoreAllMocks();
  });
});

describe('PcStore when the account changes', () => {
  afterEach(() => localStorage.clear());

  /** Um pedido de movimento que só termina quando o teste manda. */
  function hangingPointer(api: ReturnType<typeof setup>['api']) {
    let finish: () => void = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    return () => finish();
  }

  it('a movement scheduled by one account never leaves after the next person signed in', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);

    store.movePointer(10, 0, 16); // sai já e fica em voo
    store.movePointer(20, 0, 16); // fica esperando atrás dele
    expect(api.pointer).toHaveBeenCalledTimes(1);

    signIn('conta-b');
    TestBed.tick();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.pointer).toHaveBeenCalledTimes(1);

    // E o store segue utilizável para a pessoa nova.
    store.movePointer(5, 0, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledTimes(2);
  });

  it('a movement still waiting is dropped even before the effect noticed the change', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);
    store.movePointer(10, 0, 16);
    store.movePointer(20, 0, 16);

    signIn('conta-b'); // sem `TestBed.tick()`: quem barra é a conferência na hora de enviar
    finish();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(api.pointer).toHaveBeenCalledTimes(1);
  });

  it('an active drag does not carry over: the next toggle presses, it does not release (the UP of the old one went before the switch)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);

    signIn('conta-b');
    TestBed.tick();
    expect(store.dragging()).toBe(false);

    await store.toggleDrag();
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'DOWN'],
    ]);
    expect(store.dragging()).toBe(true);
  });

  it('a click that was waiting for the movement of another account is not sent', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);
    store.movePointer(10, 0, 16);

    const clicking = store.click('LEFT');
    await flush();
    signIn('conta-b');
    finish();

    expect((await clicking)?.kind).toBe('unavailable');
    expect(api.click).not.toHaveBeenCalled();
  });

  it('a drag that finished after the change does not mark the new account as dragging', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dragging = store.toggleDrag();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finish();
    await dragging;
    expect(store.dragging()).toBe(false);
  });
});
