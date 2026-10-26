import { TestBed } from '@angular/core/testing';
import {
  PWA_ENABLED,
  PwaUpdateService,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_RELOAD_FALLBACK_MS,
} from './pwa-update.service';
import { registerServiceWorker } from './register-sw';

class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn().mockResolvedValue(undefined);
}

function stubServiceWorker(registration: FakeRegistration, controller: object | null) {
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn().mockResolvedValue(registration),
  });
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  });
  return container;
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('registerServiceWorker', () => {
  afterEach(() => Reflect.deleteProperty(window.navigator, 'serviceWorker'));

  it('does nothing outside production', async () => {
    const registration = new FakeRegistration();
    const container = stubServiceWorker(registration, null);
    expect(await registerServiceWorker(window, false)).toBeUndefined();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('registers /sw.js at the root scope in production', async () => {
    const registration = new FakeRegistration();
    const container = stubServiceWorker(registration, null);
    expect(await registerServiceWorker(window, true)).toBe(registration);
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('reports a failed registration to the caller', async () => {
    const container = stubServiceWorker(new FakeRegistration(), null);
    container.register.mockRejectedValue(new Error('bloqueado'));
    await expect(registerServiceWorker(window, true)).rejects.toThrow('bloqueado');
  });
});

describe('PwaUpdateService', () => {
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
    vi.restoreAllMocks();
  });

  function setup(controller: object | null) {
    const registration = new FakeRegistration();
    const container = stubServiceWorker(registration, controller);
    TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: true }] });
    const service = TestBed.inject(PwaUpdateService);
    service.start();
    return { registration, container, service };
  }

  it('does not offer an update on the very first install', async () => {
    const { registration, service } = setup(null);
    await flush();
    const incoming = new FakeWorker();
    registration.installing = incoming;
    registration.dispatchEvent(new Event('updatefound'));
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    expect(service.updateReady()).toBe(false);
  });

  it('offers an update when a new worker finishes installing under a controller', async () => {
    const { registration, service } = setup({});
    await flush();
    const incoming = new FakeWorker();
    registration.installing = incoming;
    registration.dispatchEvent(new Event('updatefound'));
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    expect(service.updateReady()).toBe(true);
  });

  it('detects an update already installing when registration resolves', async () => {
    const { registration, service } = setup({});
    const incoming = new FakeWorker();
    incoming.state = 'installed';
    registration.installing = incoming;
    await flush();
    expect(service.updateReady()).toBe(true);
  });

  it('tries registration again when the first opening was offline and the connection returns', async () => {
    const registration = new FakeRegistration();
    const container = stubServiceWorker(registration, {});
    container.register.mockRejectedValueOnce(new Error('offline'));
    TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: true }] });
    const service = TestBed.inject(PwaUpdateService);
    service.start();
    await flush();
    expect(container.register).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    await flush();
    expect(container.register).toHaveBeenCalledTimes(2);
  });

  it('checks the existing registration when the connection returns and avoids repeated checks', async () => {
    const { registration } = setup({});
    await flush();

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(UPDATE_CHECK_THROTTLE_MS);
      window.dispatchEvent(new Event('online'));
      await vi.runAllTimersAsync();
      expect(registration.update).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the waiting worker to take over and reloads only after the user accepted', async () => {
    const { registration, container, service } = setup({});
    await flush();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);

    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();

    const waiting = new FakeWorker();
    registration.waiting = waiting;
    service.applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(service.applyingUpdate()).toBe(true);
    service.applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledTimes(1);
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads after a short wait when the new controller does not announce itself', async () => {
    const { registration, container, service } = setup({});
    await flush();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    registration.waiting = new FakeWorker();

    vi.useFakeTimers();
    try {
      service.applyUpdate();
      vi.advanceTimersByTime(UPDATE_RELOAD_FALLBACK_MS);
      expect(reload).toHaveBeenCalledTimes(1);
      container.dispatchEvent(new Event('controllerchange'));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks again and reloads even if the waiting worker vanished before the touch', async () => {
    const { registration, service } = setup({});
    await flush();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    registration.update.mockClear();

    vi.useFakeTimers();
    try {
      service.applyUpdate();
      expect(registration.update).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(UPDATE_RELOAD_FALLBACK_MS);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(service.updateError()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error only when reloading itself is impossible', async () => {
    const { registration, container, service } = setup({});
    await flush();
    registration.waiting = new FakeWorker();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload: () => {
        throw new Error('bloqueado');
      },
    } as Location);

    service.applyUpdate();
    container.dispatchEvent(new Event('controllerchange'));
    expect(service.updateError()).toBe(true);
    expect(service.applyingUpdate()).toBe(false);
  });

  it('stays out of the way when disabled', () => {
    const container = stubServiceWorker(new FakeRegistration(), null);
    TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
    TestBed.inject(PwaUpdateService).start();
    expect(container.register).not.toHaveBeenCalled();
  });
});
