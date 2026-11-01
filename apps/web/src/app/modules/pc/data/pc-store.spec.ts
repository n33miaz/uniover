import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { PC_POLL_MS, PcStore } from './pc-store';

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
    store.scrollPointer(0, 40);
    await flush();
    expect(api.pointer).toHaveBeenCalledWith(0, 0, 0, -120);
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

  it('an active drag does not carry over: the next toggle presses, it does not release', async () => {
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
