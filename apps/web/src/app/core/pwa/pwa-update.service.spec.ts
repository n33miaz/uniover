import { TestBed } from '@angular/core/testing';
import {
  PWA_ENABLED,
  PwaUpdateService,
  UPDATE_ACTIVATION_TIMEOUT_MS,
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

  it('survives a failed registration', async () => {
    const container = stubServiceWorker(new FakeRegistration(), null);
    container.register.mockRejectedValue(new Error('bloqueado'));
    expect(await registerServiceWorker(window, true)).toBeUndefined();
  });
});

describe('PwaUpdateService', () => {
  afterEach(() => Reflect.deleteProperty(window.navigator, 'serviceWorker'));

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

  it('explains when the waiting worker disappeared instead of making Atualizar a silent no-op', async () => {
    const { service } = setup({});
    await flush();
    service.updateReady.set(true);
    service.applyUpdate();
    expect(service.updateError()).toBe(true);
    expect(service.applyingUpdate()).toBe(false);
  });

  it('reenables retry if activation never changes the controller', async () => {
    const { registration, service } = setup({});
    await flush();
    registration.waiting = new FakeWorker();
    vi.useFakeTimers();
    try {
      service.applyUpdate();
      vi.advanceTimersByTime(UPDATE_ACTIVATION_TIMEOUT_MS);
      expect(service.applyingUpdate()).toBe(false);
      expect(service.updateError()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays out of the way when disabled', () => {
    const container = stubServiceWorker(new FakeRegistration(), null);
    TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
    TestBed.inject(PwaUpdateService).start();
    expect(container.register).not.toHaveBeenCalled();
  });
});
