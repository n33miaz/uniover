import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { MAX_PENDING_ZOOM_STEPS, PcStore, VOLUME_REFRESH_MS } from './pc-store';

interface VolumeChange {
  level?: number;
  muted?: boolean;
}

function setup(initial: PcStatus | null = status()) {
  const current = signal<PcStatus | null>(initial);
  const availability = {
    status: current.asReadonly(),
    apps: () => current()?.apps ?? [],
    capabilities: () => current()?.capabilities ?? [],
    volume: () => current()?.volume ?? null,
    refresh: vi.fn(() => Promise.resolve(true)),
  };
  const api = {
    pointer: vi.fn(() => Promise.resolve()),
    click: vi.fn(() => Promise.resolve()),
    key: vi.fn(() => Promise.resolve()),
    keyRelease: vi.fn(() => Promise.resolve()),
    text: vi.fn(() => Promise.resolve()),
    edit: vi.fn(() => Promise.resolve()),
    media: vi.fn(() => Promise.resolve()),
    power: vi.fn(() => Promise.resolve()),
    launch: vi.fn(() => Promise.resolve()),
    zoom: vi.fn<(steps: number) => Promise<void>>(() => Promise.resolve()),
    volume: vi.fn<(change: VolumeChange) => Promise<void>>(() => Promise.resolve()),
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

/** Uma chamada da API que só termina quando o teste manda: prova o que acontece enquanto um pedido está em voo. */
function gated<T>(calls: T[]) {
  const gates: (() => void)[] = [];
  const fn = (arg: T) => {
    calls.push(arg);
    return new Promise<void>((resolve) => gates.push(resolve));
  };
  return { fn, release: () => gates.shift()?.() };
}

describe('PcStore pinch zoom', () => {
  const ZOOM = ['pc.pointer.zoom.v1'];

  it('is a capability of the agent, and nothing is sent without it', async () => {
    const without = setup(status());
    expect(without.store.supportsZoom()).toBe(false);
    without.store.zoomPointer(3);
    await flush();
    expect(without.api.zoom).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const declared = setup(status({ capabilities: ZOOM }));
    expect(declared.store.supportsZoom()).toBe(true);
  });

  it('sends the steps through the API, one request, and nothing for zero or for a number that is not one', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    store.zoomPointer(0);
    store.zoomPointer(Number.NaN);
    store.zoomPointer(0.4);
    await flush();
    expect(api.zoom).not.toHaveBeenCalled();
    store.zoomPointer(-3);
    await flush();
    expect(api.zoom).toHaveBeenCalledExactlyOnceWith(-3);
  });

  it('steps given before the request leaves go in the same request', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    store.zoomPointer(2);
    store.zoomPointer(3);
    store.zoomPointer(-1);
    await flush();
    expect(api.zoom).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('while a request is in flight the steps add up, and the next one carries the sum', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    const calls: number[] = [];
    const slow = gated(calls);
    api.zoom.mockImplementation(slow.fn);
    store.zoomPointer(2);
    await flush();
    store.zoomPointer(3);
    store.zoomPointer(4);
    expect(calls).toEqual([2]);
    slow.release();
    await flush();
    expect(calls).toEqual([2, 7]);
    slow.release();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('never sends more than 12 steps in a request, and never queues more than it can use', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    store.zoomPointer(500);
    for (let round = 0; round < 6; round++) await flush();
    const sent = api.zoom.mock.calls.map(([steps]) => steps);
    expect(sent.every((steps) => steps <= 12)).toBe(true);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(MAX_PENDING_ZOOM_STEPS);
  });

  it('a failed request drops what was waiting, and the screen is told', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    api.zoom.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    store.zoomPointer(1);
    await flush();
    store.zoomPointer(2); // chega depois da falha: o que esperava antes dela já foi descartado
    await flush();
    expect(store.notice()).not.toBeNull();
    expect(api.zoom.mock.calls.map(([steps]) => steps)).toEqual([1, 2]);
  });

  it('with the PC offline nothing is sent', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM, online: false }));
    store.zoomPointer(3);
    await flush();
    expect(api.zoom).not.toHaveBeenCalled();
  });

  it('goes in the input queue, after the key that was asked before it', async () => {
    const { store, api } = setup(status({ capabilities: ZOOM }));
    const order: string[] = [];
    api.key.mockImplementation(() => {
      order.push('key');
      return Promise.resolve();
    });
    api.zoom.mockImplementation(() => {
      order.push('zoom');
      return Promise.resolve();
    });
    void store.sendKey('C');
    store.zoomPointer(2);
    await flush();
    await flush();
    expect(order).toEqual(['key', 'zoom']);
  });
});

describe('PcStore absolute volume', () => {
  const VOLUME = ['pc.volume.v1'];

  it('is a capability of the agent; without it there is no volume and nothing is sent', async () => {
    const { store, api } = setup(status({ volume: { level: 40, muted: false } }));
    expect(store.supportsVolume()).toBe(false);
    expect(store.volume()).toBeNull();
    expect(await store.setVolume({ level: 10 })).not.toBeNull();
    expect(api.volume).not.toHaveBeenCalled();
  });

  it('shows what the PC announced, and nothing before it did', () => {
    const none = setup(status({ capabilities: VOLUME }));
    expect(none.store.volume()).toBeNull();
    none.current.set(status({ capabilities: VOLUME, volume: { level: 40, muted: true } }));
    expect(none.store.volume()).toEqual({ level: 40, muted: true });
  });

  it('sends the level through the API, and shows it at once', async () => {
    const { store, api } = setup(
      status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
    );
    const done = store.setVolume({ level: 65 });
    expect(store.volume()).toEqual({ level: 65, muted: false });
    expect(await done).toBeNull();
    expect(api.volume).toHaveBeenCalledExactlyOnceWith({ level: 65 });
  });

  it('clips the level to 0 to 100 and sends the mute as asked', async () => {
    const { store, api } = setup(
      status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
    );
    await store.setVolume({ level: 250 });
    await store.setVolume({ level: -5, muted: true });
    expect(api.volume).toHaveBeenNthCalledWith(1, { level: 100 });
    expect(api.volume).toHaveBeenNthCalledWith(2, { level: 0, muted: true });
  });

  it('one request at a time: the newest level wins over the ones that waited', async () => {
    const { store, api } = setup(
      status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
    );
    const calls: VolumeChange[] = [];
    const slow = gated(calls);
    api.volume.mockImplementation(slow.fn);
    void store.setVolume({ level: 10 });
    await flush();
    void store.setVolume({ level: 20 });
    void store.setVolume({ level: 30 });
    expect(calls.map((change) => change.level)).toEqual([10]);
    expect(store.volume()?.level).toBe(30);
    slow.release();
    await flush();
    expect(calls.map((change) => change.level)).toEqual([10, 30]);
    slow.release();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('a failure goes back to what the PC said, and is returned', async () => {
    const { store, api } = setup(
      status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
    );
    api.volume.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    const failure = await store.setVolume({ level: 90 });
    expect(failure).not.toBeNull();
    expect(store.volume()).toEqual({ level: 40, muted: false });
  });

  it('reads the state again after the change, and then shows what the PC said', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, availability, current } = setup(
        status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
      );
      await store.setVolume({ level: 65 });
      expect(availability.refresh).not.toHaveBeenCalled();
      expect(store.volume()?.level).toBe(65);
      current.set(status({ capabilities: VOLUME, volume: { level: 64, muted: false } }));
      await vi.advanceTimersByTimeAsync(VOLUME_REFRESH_MS + 1);
      expect(availability.refresh).toHaveBeenCalledTimes(1);
      expect(store.volume()).toEqual({ level: 64, muted: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the volume keys and the mute key also read the state again, once for a burst', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, availability } = setup(
        status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
      );
      await store.sendMedia('VOLUME_UP');
      await store.sendMedia('VOLUME_UP', 2);
      await store.sendMedia('MUTE');
      await store.sendMedia('PLAY_PAUSE');
      await vi.advanceTimersByTimeAsync(VOLUME_REFRESH_MS + 1);
      expect(availability.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a PC without the volume does not read the state again after the volume keys', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, availability } = setup(status());
      await store.sendMedia('VOLUME_UP');
      await vi.advanceTimersByTimeAsync(VOLUME_REFRESH_MS + 1);
      expect(availability.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the level asked by an account is never shown to the next one', async () => {
    const { store, api } = setup(
      status({ capabilities: VOLUME, volume: { level: 40, muted: false } }),
    );
    signIn('conta-a');
    TestBed.tick();
    const calls: VolumeChange[] = [];
    api.volume.mockImplementation(gated(calls).fn);
    void store.setVolume({ level: 90 });
    await flush();
    expect(store.volume()?.level).toBe(90);
    signIn('conta-b');
    TestBed.tick();
    expect(store.volume()).toEqual({ level: 40, muted: false });
  });
});
