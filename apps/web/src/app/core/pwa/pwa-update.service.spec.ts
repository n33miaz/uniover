import { TestBed } from '@angular/core/testing';
import {
  AUTO_RECOVERY_GUARD_MS,
  CHUNK_RECOVERY_KEY,
  FIRST_CONTENT_WATCHDOG_MS,
  PWA_ENABLED,
  PwaUpdateService,
  UPDATE_ACTIVATE_TIMEOUT_MS,
  UPDATE_CACHE_CLEAR_TIMEOUT_MS,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_FLAG_MAX_AGE_MS,
  UPDATE_INSTALL_TIMEOUT_MS,
  UPDATE_REFRESHING_KEY,
  UPDATE_WATCHDOG_KEY,
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
  unregister = vi.fn().mockResolvedValue(true);
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

/** O jsdom não tem `caches`: este substituto guarda só os nomes e conta o que foi apagado. */
function stubCaches(names: string[]) {
  const storage = {
    keys: vi.fn().mockResolvedValue(names),
    delete: vi.fn().mockResolvedValue(true),
  };
  Object.defineProperty(window, 'caches', { value: storage, configurable: true });
  return storage;
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
  const realFetch = window.fetch;

  /** O último recurso sonda a rede antes de desfazer o registro; aqui a rede é um substituto (de pé por padrão). */
  function stubFetch(ok = true) {
    const fetchSpy = vi.fn().mockResolvedValue({ ok });
    Object.defineProperty(window, 'fetch', { value: fetchSpy, configurable: true });
    return fetchSpy;
  }

  afterEach(() => {
    Object.defineProperty(window, 'fetch', { value: realFetch, configurable: true });
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
    Reflect.deleteProperty(window, 'caches');
    sessionStorage.clear();
    vi.useRealTimers();
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

  function stubReload() {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    return reload;
  }

  function stubAssign() {
    const assign = vi.fn();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
      reload,
    } as unknown as Location);
    return { assign, reload };
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
    vi.advanceTimersByTime(UPDATE_CHECK_THROTTLE_MS);
    window.dispatchEvent(new Event('online'));
    await vi.runAllTimersAsync();
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('stays out of the way when disabled', () => {
    const container = stubServiceWorker(new FakeRegistration(), null);
    TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
    TestBed.inject(PwaUpdateService).start();
    expect(container.register).not.toHaveBeenCalled();
  });

  describe('applying an update', () => {
    it('waits for the new worker to take control, clears only runtime caches, then reloads once', async () => {
      const { registration, container, service } = setup({});
      await flush();
      const reload = stubReload();
      const caches = stubCaches([
        'workbox-precache-v2-http://localhost/',
        'exercise-art',
        'workbox-runtime-http://localhost/',
        'dados-velhos',
      ]);
      const waiting = new FakeWorker();
      registration.waiting = waiting;

      // Uma troca de controlador que ninguém pediu (outra aba) não recarrega esta.
      container.dispatchEvent(new Event('controllerchange'));
      expect(reload).not.toHaveBeenCalled();

      service.applyUpdate();
      expect(service.showSkeleton()).toBe(true);
      expect(service.applyingUpdate()).toBe(true);
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      service.applyUpdate();
      expect(waiting.postMessage).toHaveBeenCalledTimes(1);

      // Enquanto o worker novo não assume, nada de recarregar (era aqui que a casca antiga voltava).
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(caches.delete).not.toHaveBeenCalled();

      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(caches.delete.mock.calls.map(([name]) => name).sort()).toEqual([
        'dados-velhos',
        'workbox-runtime-http://localhost/',
      ]);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(UPDATE_REFRESHING_KEY)).not.toBeNull();
      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('also accepts the worker reaching the activated state as the signal', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      const waiting = new FakeWorker();
      registration.waiting = waiting;
      service.applyUpdate();
      await flush();
      waiting.state = 'activated';
      waiting.dispatchEvent(new Event('statechange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('drops the stale registration and reloads when the new worker never takes control in time', async () => {
      const { registration, container, service } = setup({});
      await flush();
      const reload = stubReload();
      const fetchSpy = stubFetch();
      const caches = stubCaches(['workbox-precache-v2-http://localhost/', 'exercise-art', 'velho']);
      registration.waiting = new FakeWorker();

      vi.useFakeTimers();
      service.applyUpdate();
      await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      expect(registration.unregister).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      // Recarregar sob o worker antigo devolveria a casca antiga: o registro cai e a recarga vem da rede.
      expect(fetchSpy).toHaveBeenCalledWith('/health/version', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      expect(registration.unregister).toHaveBeenCalledTimes(1);
      // O precache antigo sai (o registro desfeito ainda serviria a casca velha por ele); a arte dos exercícios fica.
      expect(caches.delete.mock.calls.map(([name]) => name).sort()).toEqual([
        'velho',
        'workbox-precache-v2-http://localhost/',
      ]);
      expect(reload).toHaveBeenCalledTimes(1);
      container.dispatchEvent(new Event('controllerchange'));
      await vi.advanceTimersByTimeAsync(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('keeps the worker, and still reloads, when the network does not answer', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      const fetchSpy = stubFetch(false);
      const caches = stubCaches(['workbox-precache-v2-http://localhost/']);
      registration.waiting = new FakeWorker();

      vi.useFakeTimers();
      service.applyUpdate();
      await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Sem rede o app depende do worker para abrir: nada de desfazer o registro.
      expect(registration.unregister).not.toHaveBeenCalled();
      expect(caches.delete).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not count a replaced worker as taking over: it retries with the one that replaced it', async () => {
      const { registration, container, service } = setup({});
      await flush();
      const reload = stubReload();
      const fetchSpy = stubFetch();
      const first = new FakeWorker();
      registration.waiting = first;

      service.applyUpdate();
      await flush();
      expect(first.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

      // Outro deploy chegou: o worker que esperava virou `redundant` e há um mais novo esperando.
      const second = new FakeWorker();
      second.state = 'installed';
      registration.waiting = second;
      first.state = 'redundant';
      first.dispatchEvent(new Event('statechange'));
      await flush();
      // Antes do conserto isto recarregava aqui, sob o worker antigo, e o aviso voltava.
      expect(reload).not.toHaveBeenCalled();
      expect(second.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(registration.unregister).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back to dropping the registration when the replacement never takes control either', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      stubFetch();
      const first = new FakeWorker();
      registration.waiting = first;

      vi.useFakeTimers();
      service.applyUpdate();
      await vi.advanceTimersByTimeAsync(0);
      registration.waiting = new FakeWorker();
      first.state = 'redundant';
      first.dispatchEvent(new Event('statechange'));
      await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS);
      expect(registration.unregister).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('asks for a check and waits for the install when no worker was waiting', async () => {
      const { registration, container, service } = setup({});
      await flush();
      const reload = stubReload();
      registration.update.mockClear();
      const incoming = new FakeWorker();
      registration.update.mockImplementation(() => {
        registration.installing = incoming;
        return Promise.resolve();
      });

      service.applyUpdate();
      await flush();
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(incoming.postMessage).not.toHaveBeenCalled();

      incoming.state = 'installed';
      registration.waiting = incoming;
      incoming.dispatchEvent(new Event('statechange'));
      await flush();
      expect(incoming.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(reload).not.toHaveBeenCalled();

      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads right away when the check finds nothing newer', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      const fetchSpy = stubFetch();
      registration.update.mockClear();

      service.applyUpdate();
      await flush();
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(service.updateError()).toBe(false);
      // Nada mais novo a ativar não é falha: sem o último recurso.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('gives up on an install that never finishes and reloads at the deadline', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      const fetchSpy = stubFetch();
      registration.update.mockImplementation(() => {
        registration.installing = new FakeWorker();
        return Promise.resolve();
      });

      vi.useFakeTimers();
      service.applyUpdate();
      await vi.advanceTimersByTimeAsync(UPDATE_INSTALL_TIMEOUT_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(registration.unregister).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('keeps going when the check for a new version fails', async () => {
      const { registration, service } = setup({});
      await flush();
      const reload = stubReload();
      registration.update.mockRejectedValue(new Error('offline'));
      service.applyUpdate();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not let a stuck cache cleanup hold the reload', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      const caches = stubCaches(['velho']);
      caches.keys.mockReturnValue(new Promise(() => undefined));

      vi.useFakeTimers();
      service.applyUpdate();
      await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('survives a cache cleanup that fails', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      stubCaches(['velho']).keys.mockRejectedValue(new Error('bloqueado'));
      service.applyUpdate();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
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
      await flush();
      expect(service.updateError()).toBe(true);
      expect(service.applyingUpdate()).toBe(false);
      expect(service.showSkeleton()).toBe(false);
      expect(sessionStorage.getItem(UPDATE_REFRESHING_KEY)).toBeNull();
    });
  });

  describe('recovering from a stale shell', () => {
    it('runs the update path once and refuses a second automatic recovery inside the window', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();

      expect(service.recoverFromStaleShell()).toBe(true);
      expect(service.showSkeleton()).toBe(true);
      // Já em curso: o mesmo erro, de novo, é tratado como o mesmo socorro.
      expect(service.recoverFromStaleShell()).toBe(true);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).not.toBeNull();

      // A página nova, ainda dentro da janela, falhando de novo: a guarda nega e o erro segue o caminho normal.
      TestBed.resetTestingModule();
      sessionStorage.removeItem(UPDATE_REFRESHING_KEY);
      setup({});
      const again = TestBed.inject(PwaUpdateService);
      expect(again.recoverFromStaleShell()).toBe(false);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('goes straight to the route that failed, and only to paths inside the app', async () => {
      const { service } = setup({});
      await flush();
      const { assign, reload } = stubAssign();
      expect(service.recoverFromStaleShell('/conectar?x=1')).toBe(true);
      await flush();
      expect(assign).toHaveBeenCalledWith('/conectar?x=1');
      expect(reload).not.toHaveBeenCalled();

      sessionStorage.clear();
      TestBed.resetTestingModule();
      const other = setup({}).service;
      expect(other.recoverFromStaleShell('//evil.example/x')).toBe(true);
      await flush();
      expect(assign).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('allows a new recovery once the guard window has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      expect(service.recoverFromStaleShell()).toBe(true);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + AUTO_RECOVERY_GUARD_MS + 1);
      sessionStorage.removeItem(UPDATE_REFRESHING_KEY);
      TestBed.resetTestingModule();
      setup({});
      expect(TestBed.inject(PwaUpdateService).recoverFromStaleShell()).toBe(true);
    });

    it('works without a service worker or browser storage', async () => {
      TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
      const service = TestBed.inject(PwaUpdateService);
      const reload = stubReload();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('bloqueado');
      });
      expect(service.recoverFromStaleShell()).toBe(true);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('after the reload', () => {
    function boot() {
      TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
      return TestBed.inject(PwaUpdateService);
    }

    it('keeps the skeleton until the first real content and disarms the watchdog', async () => {
      sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const service = boot();
      const reload = stubReload();
      expect(service.showSkeleton()).toBe(true);
      // A marca vale para uma recarga só.
      expect(sessionStorage.getItem(UPDATE_REFRESHING_KEY)).toBeNull();

      service.markContentReady();
      expect(service.showSkeleton()).toBe(false);
      await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS * 2);
      expect(reload).not.toHaveBeenCalled();
    });

    it('ignores an old mark and a mark nobody set', () => {
      expect(boot().showSkeleton()).toBe(false);
      TestBed.resetTestingModule();
      sessionStorage.setItem(
        UPDATE_REFRESHING_KEY,
        String(Date.now() - UPDATE_FLAG_MAX_AGE_MS - 1),
      );
      expect(boot().showSkeleton()).toBe(false);
    });

    it('reloads once when no content shows up in time, and then gives up', async () => {
      sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      boot();
      const reload = stubReload();
      await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(UPDATE_WATCHDOG_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(UPDATE_REFRESHING_KEY)).not.toBeNull();

      // A recarga trouxe a mesma falta de conteúdo: a segunda vez só libera a tela, sem recarregar.
      TestBed.resetTestingModule();
      const second = boot();
      expect(second.showSkeleton()).toBe(true);
      await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
      expect(second.showSkeleton()).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the content arrived before the watchdog fires', async () => {
      sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const service = boot();
      const reload = stubReload();
      service.markContentReady();
      service.markContentReady();
      await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
