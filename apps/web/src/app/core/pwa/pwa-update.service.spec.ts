import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import {
  AUTO_RECOVERY_GUARD_MS,
  CHUNK_RECOVERY_KEY,
  CONTROLLER_CHANGE_KEY,
  FIRST_CONTENT_WATCHDOG_MS,
  LEAVING_GRACE_MS,
  PWA_ENABLED,
  PwaUpdateService,
  TAB_LOCK_NAME,
  UPDATE_ACTIVATE_TIMEOUT_MS,
  UPDATE_CACHE_CLEAR_TIMEOUT_MS,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_FLAG_MAX_AGE_MS,
  UPDATE_INSTALL_TIMEOUT_MS,
  UPDATE_REFRESHING_KEY,
  UPDATE_WRITES_WAIT_MS,
  UPDATE_WATCHDOG_KEY,
} from './pwa-update.service';
import { registerServiceWorker } from './register-sw';
import { OTHER_TABS_ANSWER_TIMEOUT_MS, answerTabBusyQueries } from './tab-busy';
import { FakeBroadcastChannel, installFakeBroadcastChannel } from './tab-busy-test-kit';
import { AUTO_REQUEST_MAX_AGE_MS, UnsavedWork } from './unsaved-work';

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

/** O jsdom não tem Web Locks: este substituto diz quantas abas seguram o bloqueio (`null`: o navegador não tem Web Locks). */
let locksChosen = false;
function stubLocks(held: number | null) {
  locksChosen = true;
  const locks =
    held === null
      ? undefined
      : {
          request: vi.fn().mockResolvedValue(undefined),
          query: vi.fn().mockResolvedValue({
            held: Array.from({ length: held }, () => ({ name: TAB_LOCK_NAME })),
            pending: [],
          }),
        };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
  return locks as NonNullable<typeof locks>;
}

/** O toque decide em passos assíncronos (escritas, abas): espera a decisão terminar. */
async function tap(service: PwaUpdateService): Promise<void> {
  await service.applyUpdate();
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
    Reflect.deleteProperty(window.navigator, 'locks');
    locksChosen = false;
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(controller: object | null) {
    const registration = new FakeRegistration();
    const container = stubServiceWorker(registration, controller);
    // Por padrão o teste é de uma aba só (o toque não precisa perguntar às outras); quem quer outra coisa chama `stubLocks`.
    if (!locksChosen) stubLocks(1);
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

      await tap(service);
      expect(service.showSkeleton()).toBe(true);
      expect(service.applyingUpdate()).toBe(true);
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      await tap(service);
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
      await tap(service);
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
      await tap(service);
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
      await tap(service);
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

      await tap(service);
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
      await tap(service);
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

      await tap(service);
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

      await tap(service);
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
      await tap(service);
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
      await tap(service);
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
      await tap(service);
      await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('survives a cache cleanup that fails', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      stubCaches(['velho']).keys.mockRejectedValue(new Error('bloqueado'));
      await tap(service);
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

      await tap(service);
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

    it('does not hijack the navigation of a page that is already leaving', async () => {
      const { service } = setup({});
      await flush();
      const { assign, reload } = stubAssign();
      // O navegador aborta a importação em voo ao sair da página: a falha chega depois do `pagehide`.
      window.dispatchEvent(new Event('pagehide'));
      expect(service.recoverFromStaleShell('/')).toBe(true);
      await flush();
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
    });

    it('waits for the pagehide after a beforeunload, and recovers only if the page stayed', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      const { service } = setup({});
      const { assign } = stubAssign();
      // A navegação da pessoa aborta a importação em voo antes do `pagehide`: a falha não é casca velha.
      window.dispatchEvent(new Event('beforeunload'));
      expect(service.recoverFromStaleShell('/')).toBe(true);
      await vi.advanceTimersByTimeAsync(LEAVING_GRACE_MS - 1);
      expect(assign).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(5);
      expect(assign).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
    });

    it('recovers after the grace period when the leave was given up (no pagehide)', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      const { service } = setup({});
      const { assign } = stubAssign();
      window.dispatchEvent(new Event('beforeunload'));
      expect(service.recoverFromStaleShell('/treino')).toBe(true);
      await vi.advanceTimersByTimeAsync(LEAVING_GRACE_MS + 1);
      expect(assign).toHaveBeenCalledWith('/treino');
    });

    it('recovers again when a page restored from the back/forward cache fails to load a chunk', async () => {
      const { service } = setup({});
      await flush();
      const { assign } = stubAssign();
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      expect(service.recoverFromStaleShell('/treino')).toBe(true);
      await flush();
      expect(assign).toHaveBeenCalledWith('/treino');
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

  describe('with unsaved work', () => {
    let busy = false;

    /** Uma navegação concluída (o serviço escuta o roteador sozinho). */
    function navigated() {
      (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
        new NavigationEnd(1, '/a', '/a'),
      );
    }

    function setupBusy(initial = true) {
      busy = initial;
      const made = setup({});
      TestBed.inject(UnsavedWork).register(() => busy);
      const waiting = new FakeWorker();
      made.registration.waiting = waiting;
      return { ...made, waiting };
    }

    it('defers an automatic recovery: no reload, no worker touched, notice visible, no skeleton, guard untouched', async () => {
      const { service, waiting, registration } = setupBusy();
      await flush();
      const reload = stubReload();

      expect(service.recoverFromStaleShell('/treino')).toBe(true);
      await flush();

      expect(reload).not.toHaveBeenCalled();
      expect(waiting.postMessage).not.toHaveBeenCalled();
      expect(registration.unregister).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
      expect(service.applyingUpdate()).toBe(false);
      expect(service.showSkeleton()).toBe(false);
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
    });

    it('has no clock: it waits for a safe moment, and a new try to navigate is one', async () => {
      const { service, waiting } = setupBusy();
      await flush();
      const { assign, reload } = stubAssign();
      service.recoverFromStaleShell('/treino');

      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
      busy = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(reload).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      vi.useRealTimers();

      expect(service.recoverFromStaleShell('/treino')).toBe(true);
      await flush();
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/treino');
      expect(waiting.postMessage).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).not.toBeNull();
    });

    it('shows no skeleton at any point of a deferred retry, not even while it reloads', async () => {
      const { service } = setupBusy();
      await flush();
      const reload = stubReload();
      const seen: boolean[] = [];
      const look = () => seen.push(service.showSkeleton() || service.applyingUpdate());

      service.recoverFromStaleShell();
      look();
      navigated();
      look();
      document.dispatchEvent(new Event('visibilitychange'));
      look();
      busy = false;
      navigated();
      look();
      await flush();
      look();

      expect(reload).toHaveBeenCalledTimes(1);
      expect(seen.every((shown) => !shown)).toBe(true);
    });

    it('reloads when a navigation ends on a clean screen, and drops the target of the old failed one', async () => {
      const { service } = setupBusy();
      await flush();
      const { assign, reload } = stubAssign();
      service.recoverFromStaleShell('/treino');

      navigated();
      await flush();
      expect(reload).not.toHaveBeenCalled();

      busy = false;
      navigated();
      await flush();
      // A pessoa já seguiu para outra tela: recarrega onde ela está, nunca no alvo antigo.
      expect(assign).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads when the person comes back to the tab on a clean screen', async () => {
      const { service } = setupBusy();
      await flush();
      const reload = stubReload();
      service.recoverFromStaleShell();
      busy = false;
      await flush();
      expect(reload).not.toHaveBeenCalled();

      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('holds the reload while a write is in flight', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      const end = TestBed.inject(UnsavedWork).beginRequest();

      service.recoverFromStaleShell();
      navigated();
      await flush();
      expect(reload).not.toHaveBeenCalled();
      end();
      navigated();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    describe('automatic recovery never touches the workers', () => {
      it('reloads a clean tab without activating the waiting worker, unregistering or deleting caches', async () => {
        const { service, waiting, registration } = setupBusy(false);
        const caches = stubCaches(['runtime-x', 'workbox-precache-v1']);
        await flush();
        const reload = stubReload();

        service.recoverFromStaleShell();
        await flush();

        expect(reload).toHaveBeenCalledTimes(1);
        expect(waiting.postMessage).not.toHaveBeenCalled();
        expect(registration.unregister).not.toHaveBeenCalled();
        expect(caches.delete).not.toHaveBeenCalled();
      });

      it('does not activate a waiting worker on load, update found, online, visibility or navigation either', async () => {
        const { registration, service } = setup({});
        await flush();
        const waiting = new FakeWorker();
        waiting.state = 'installed';
        registration.waiting = waiting;
        registration.dispatchEvent(new Event('updatefound'));
        service.updateReady.set(true);

        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('load'));
        document.dispatchEvent(new Event('visibilitychange'));
        (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
          new NavigationEnd(1, '/a', '/a'),
        );
        await flush();

        expect(waiting.postMessage).not.toHaveBeenCalled();
      });
    });

    describe('the tap on the notice', () => {
      it('asks for confirmation first when this tab has unsaved work, and does nothing else yet', async () => {
        const { service, waiting } = setupBusy();
        await flush();
        const reload = stubReload();

        await tap(service);
        await flush();

        expect(service.confirmingUpdate()).toBe('mine');
        expect(service.applyingUpdate()).toBe(false);
        expect(service.showSkeleton()).toBe(false);
        expect(waiting.postMessage).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();

        service.cancelUpdate();
        expect(service.confirmingUpdate()).toBeNull();
        expect(waiting.postMessage).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
      });

      it('updates once the person confirms, with a plain SKIP_WAITING', async () => {
        const { service, container, waiting } = setupBusy();
        await flush();
        const reload = stubReload();

        await tap(service);
        await service.confirmUpdate();
        expect(service.confirmingUpdate()).toBeNull();
        container.dispatchEvent(new Event('controllerchange'));
        await flush();

        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('updates at once, with no question, when there is nothing to lose', async () => {
        const { service, container, waiting } = setupBusy(false);
        await flush();
        const reload = stubReload();

        await tap(service);
        expect(service.confirmingUpdate()).toBeNull();
        container.dispatchEvent(new Event('controllerchange'));
        await flush();

        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('stops the deferred reload once the person confirmed', async () => {
        const { service, container } = setupBusy();
        await flush();
        const reload = stubReload();
        service.recoverFromStaleShell();
        await service.applyUpdate();
        await service.confirmUpdate();
        container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
        busy = false;
        navigated();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
      });
    });

    describe('a worker change asked by ANOTHER tab', () => {
      it('reloads a clean tab at once, without skeleton or worker calls', async () => {
        const { container, service } = setup({});
        await flush();
        const reload = stubReload();

        container.dispatchEvent(new Event('controllerchange'));
        await flush();

        expect(reload).toHaveBeenCalledTimes(1);
        expect(service.applyingUpdate()).toBe(false);
        expect(sessionStorage.getItem(CONTROLLER_CHANGE_KEY)).not.toBeNull();
      });

      it('defers a tab with unsaved work to the next safe moment and keeps the notice up', async () => {
        const { container, service } = setupBusy();
        await flush();
        const reload = stubReload();

        container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(reload).not.toHaveBeenCalled();
        expect(service.updateReady()).toBe(true);
        expect(service.showSkeleton()).toBe(false);

        busy = false;
        navigated();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('does not mistake the first install for a swap, nor its own swap for the other tab', async () => {
        const first = setup(null);
        await flush();
        const reload = stubReload();
        first.container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(reload).not.toHaveBeenCalled();

        TestBed.resetTestingModule();
        const own = setup({});
        own.registration.waiting = new FakeWorker();
        await flush();
        await tap(own.service);
        own.container.dispatchEvent(new Event('controllerchange'));
        await flush();
        // Uma só recarga: a do próprio toque.
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('does not reload again inside the guard window', async () => {
        const { container } = setup({});
        await flush();
        const reload = stubReload();
        container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
        container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
      });
    });

    describe('the last resort (unregister and drop the precache)', () => {
      function lateFirstPaint() {
        sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      }

      it('runs only with a single tab that is clean, and then the skeleton shows', async () => {
        stubFetch();
        stubLocks(1);
        lateFirstPaint();
        const { service, registration } = setup({});
        registration.waiting = new FakeWorker();
        await vi.advanceTimersByTimeAsync(0);
        const caches = stubCaches(['runtime-x']);
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);

        expect(registration.unregister).toHaveBeenCalledTimes(1);
        expect(caches.delete).toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(service.showSkeleton()).toBe(true);
      });

      it('does not undo the worker or the precache when there is nothing newer, but still reloads', async () => {
        stubFetch();
        stubLocks(1);
        lateFirstPaint();
        const { registration } = setup({});
        await vi.advanceTimersByTimeAsync(0);
        const caches = stubCaches(['runtime-x', 'workbox-precache-v1']);
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);

        // A busca por versão nova não achou nada: o worker atual é o certo e o precache dele abre o app sem rede.
        expect(registration.update).toHaveBeenCalled();
        expect(registration.unregister).not.toHaveBeenCalled();
        expect(caches.delete).not.toHaveBeenCalledWith('workbox-precache-v1');
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('undoes the worker when the fresh check finds a newer one installing', async () => {
        stubFetch();
        stubLocks(1);
        lateFirstPaint();
        const { registration } = setup({});
        registration.update.mockImplementation(async () => {
          registration.installing = new FakeWorker();
        });
        await vi.advanceTimersByTimeAsync(0);
        stubCaches(['workbox-precache-v1']);
        stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);

        expect(registration.unregister).toHaveBeenCalledTimes(1);
      });

      it('drops a deferral from the watchdog once the content shows up, and the notice it alone raised', async () => {
        stubLocks(2);
        lateFirstPaint();
        const { service } = setup({});
        await vi.advanceTimersByTimeAsync(0);
        const reload = stubReload();
        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        // Outra aba aberta: o vigia adiou e acendeu o aviso.
        expect(service.updateReady()).toBe(true);
        expect(reload).not.toHaveBeenCalled();

        // O conteúdo aparece mesmo assim (a API só demorou a acordar).
        service.markContentReady();
        expect(service.updateReady()).toBe(false);
        expect(service.navigationBlocked()).toBe(false);

        // A outra aba fecha: nada recarrega nem desfaz o worker, porque já não há o que recuperar.
        stubLocks(1);
        (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
          new NavigationEnd(1, '/a', '/a'),
        );
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);
        expect(reload).not.toHaveBeenCalled();
      });

      it('keeps the notice when a real new worker is the reason for it, even after the content shows up', async () => {
        stubLocks(2);
        lateFirstPaint();
        const { service, registration } = setup({});
        await vi.advanceTimersByTimeAsync(0);
        stubReload();
        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        expect(service.updateReady()).toBe(true);

        // Um worker novo chega depois do adiamento: o aviso passa a ser dele.
        const incoming = new FakeWorker();
        registration.installing = incoming;
        registration.dispatchEvent(new Event('updatefound'));
        incoming.state = 'installed';
        incoming.dispatchEvent(new Event('statechange'));

        service.markContentReady();
        expect(service.updateReady()).toBe(true);
      });

      it('is deferred, with nothing deleted, when another tab may be open', async () => {
        stubFetch();
        stubLocks(2);
        lateFirstPaint();
        const { service, registration } = setup({});
        await vi.advanceTimersByTimeAsync(0);
        const caches = stubCaches(['runtime-x']);
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);

        expect(registration.unregister).not.toHaveBeenCalled();
        expect(caches.delete).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(service.showSkeleton()).toBe(false);
        expect(service.updateReady()).toBe(true);
      });

      it('counts a browser without Web Locks as "another tab may be open"', async () => {
        stubFetch();
        stubLocks(null);
        lateFirstPaint();
        const { registration } = setup({});
        await vi.advanceTimersByTimeAsync(0);
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);

        expect(registration.unregister).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
      });

      it('is deferred before even looking for other tabs when this tab has unsaved work', async () => {
        stubFetch();
        const locks = stubLocks(1);
        lateFirstPaint();
        const { service, registration } = setup({});
        TestBed.inject(UnsavedWork).register(() => true, 'form');
        await vi.advanceTimersByTimeAsync(0);
        const reload = stubReload();
        locks.query.mockClear();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);

        expect(locks.query).not.toHaveBeenCalled();
        expect(registration.unregister).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(service.showSkeleton()).toBe(false);
        // A guarda gravada, quando a recarga vier, é a do vigia: a página seguinte não repete o ciclo.
        expect(sessionStorage.getItem(UPDATE_WATCHDOG_KEY)).toBeNull();
      });

      it('goes on to the reload once the stale worker was dropped, even if work shows up meanwhile', async () => {
        stubFetch();
        stubLocks(1);
        lateFirstPaint();
        const { registration } = setup({});
        let late = false;
        TestBed.inject(UnsavedWork).register(() => late);
        await vi.advanceTimersByTimeAsync(0);
        registration.unregister.mockImplementation(() => {
          late = true;
          return Promise.resolve(true);
        });
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);

        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('registers again when the reload fails after the registration was dropped, and on the next check', async () => {
        stubFetch();
        stubLocks(1);
        lateFirstPaint();
        const { container, registration } = setup({});
        registration.waiting = new FakeWorker();
        await vi.advanceTimersByTimeAsync(0);
        vi.spyOn(window, 'location', 'get').mockReturnValue({
          ...window.location,
          reload: () => {
            throw new Error('bloqueado');
          },
        } as Location);
        expect(container.register).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);
        expect(container.register).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
        window.dispatchEvent(new Event('online'));
        await flush();
        expect(container.register.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      it('keeps its own loop guard when the watchdog had to wait for a safe moment', async () => {
        sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        stubLocks(1);
        TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
        const service = TestBed.inject(PwaUpdateService);
        busy = true;
        TestBed.inject(UnsavedWork).register(() => busy, 'form');
        const reload = stubReload();

        await vi.advanceTimersByTimeAsync(FIRST_CONTENT_WATCHDOG_MS);
        expect(reload).not.toHaveBeenCalled();
        expect(service.showSkeleton()).toBe(false);
        expect(service.updateReady()).toBe(true);
        expect(sessionStorage.getItem(UPDATE_WATCHDOG_KEY)).toBeNull();
        vi.useRealTimers();

        busy = false;
        navigated();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(UPDATE_WATCHDOG_KEY)).not.toBeNull();
        expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
      });
    });

    it('lets go of the tab lock when the page is hidden and takes it again when the back/forward cache restores it', async () => {
      const locks = stubLocks(1);
      let released = false;
      locks.request.mockImplementation(
        (_name: string, _options: unknown, hold: () => Promise<void>) => {
          const held = hold();
          void held.then(() => (released = true));
          return held;
        },
      );
      setup({});
      await flush();
      expect(locks.request).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('pagehide'));
      await flush();
      expect(released).toBe(true);

      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
      await flush();
      expect(locks.request).toHaveBeenCalledTimes(1);
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      await flush();
      expect(locks.request).toHaveBeenCalledTimes(2);
    });

    it('stops answering the other tabs when the app is torn down, leaving no channel open', async () => {
      const restore = installFakeBroadcastChannel();
      try {
        const before = FakeBroadcastChannel.openCount();
        setup({});
        await flush();
        expect(FakeBroadcastChannel.openCount()).toBe(before + 1);

        TestBed.resetTestingModule();
        expect(FakeBroadcastChannel.openCount()).toBe(before);
      } finally {
        restore();
      }
    });

    it('holds a shared tab lock for as long as the tab lives', async () => {
      const locks = stubLocks(1);
      setup({});
      await flush();
      expect(locks.request).toHaveBeenCalledTimes(1);
      expect(locks.request.mock.calls[0][0]).toBe(TAB_LOCK_NAME);
      expect(locks.request.mock.calls[0][1]).toEqual({ mode: 'shared' });
    });
  });

  describe('the tap and the other tabs', () => {
    let restoreChannel: () => void;
    let busy = false;
    const stops: (() => void)[] = [];

    beforeEach(() => {
      restoreChannel = installFakeBroadcastChannel();
    });

    afterEach(() => {
      for (const stop of stops.splice(0)) stop();
      restoreChannel();
    });

    /** Outra aba aberta, com ou sem trabalho não salvo. */
    function otherTab(isBusy: () => boolean) {
      stops.push(answerTabBusyQueries(window, isBusy, 'tab-b'));
    }

    function navigated() {
      (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
        new NavigationEnd(1, '/a', '/a'),
      );
    }

    function setupWaiting(initialBusy = false) {
      busy = initialBusy;
      const made = setup({});
      TestBed.inject(UnsavedWork).register(() => busy);
      const waiting = new FakeWorker();
      made.registration.waiting = waiting;
      return { ...made, waiting };
    }

    describe('A taps while B has unsaved work', () => {
      it('asks first, naming the other tab, and touches nothing until the person decides', async () => {
        stubLocks(2);
        otherTab(() => true);
        const { service, waiting } = setupWaiting();
        await flush();
        const reload = stubReload();

        await tap(service);

        expect(service.confirmingUpdate()).toBe('other-tab');
        expect(service.applyingUpdate()).toBe(false);
        expect(service.showSkeleton()).toBe(false);
        expect(waiting.postMessage).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
      });

      it('goes on to activate the worker if the person confirms, and not if they decline', async () => {
        stubLocks(2);
        otherTab(() => true);
        const { service, container, waiting } = setupWaiting();
        await flush();
        const reload = stubReload();

        await tap(service);
        service.cancelUpdate();
        await flush();
        expect(waiting.postMessage).not.toHaveBeenCalled();

        await tap(service);
        await service.confirmUpdate();
        container.dispatchEvent(new Event('controllerchange'));
        await flush();
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('asks about this tab first: its own unsaved work wins over the other tab', async () => {
        stubLocks(2);
        otherTab(() => true);
        const { service } = setupWaiting(true);
        await flush();

        await tap(service);
        expect(service.confirmingUpdate()).toBe('mine');
      });

      it('lets the tap through when the other tab is clean', async () => {
        stubLocks(2);
        otherTab(() => false);
        const { service, container, waiting } = setupWaiting();
        await flush();
        const reload = stubReload();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const decided = service.applyUpdate();
        await vi.advanceTimersByTimeAsync(OTHER_TABS_ANSWER_TIMEOUT_MS);
        await decided;
        container.dispatchEvent(new Event('controllerchange'));
        await vi.advanceTimersByTimeAsync(0);

        expect(service.confirmingUpdate()).toBeNull();
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(reload).toHaveBeenCalledTimes(1);
      });
    });

    it('does not undo the registration or the precache on a tap when another tab may be open', async () => {
      stubFetch();
      stubLocks(2);
      const { service, registration } = setupWaiting();
      await flush();
      const caches = stubCaches(['workbox-precache-v1']);
      const reload = stubReload();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      // O worker novo aceita o pedido mas nunca assume: sem a outra aba o último recurso desfaria o registro.
      const decided = service.applyUpdate();
      await vi.advanceTimersByTimeAsync(OTHER_TABS_ANSWER_TIMEOUT_MS);
      await decided;
      await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS + UPDATE_CACHE_CLEAR_TIMEOUT_MS);

      expect(registration.unregister).not.toHaveBeenCalled();
      expect(caches.delete).not.toHaveBeenCalledWith('workbox-precache-v1');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('treats a tab that is open but does not answer within ~500 ms as clean, so a frozen tab never blocks the tap', async () => {
      stubLocks(3);
      // Uma aba que existe (ouve o canal) e está congelada: recebe a pergunta e nunca responde.
      const frozen = new FakeBroadcastChannel('uniover.tab-busy');
      const heard = vi.fn();
      frozen.onmessage = heard;
      const { service, waiting } = setupWaiting();
      await flush();
      stubReload();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const decided = service.applyUpdate();
      await vi.advanceTimersByTimeAsync(OTHER_TABS_ANSWER_TIMEOUT_MS - 1);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(waiting.postMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await decided;
      expect(service.confirmingUpdate()).toBeNull();
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      frozen.close();
    });

    it('does not even ask (and does not wait 500 ms) when the shared lock shows a single tab', async () => {
      stubLocks(1);
      otherTab(() => true);
      const { service, waiting } = setupWaiting();
      await flush();
      stubReload();

      await tap(service);

      expect(service.confirmingUpdate()).toBeNull();
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    });

    it('lets an automatic reload go on after 5 minutes of a request that never answers', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      vi.useFakeTimers({ toFake: ['Date'] });
      TestBed.inject(UnsavedWork).beginRequest();

      service.recoverFromStaleShell();
      navigated();
      await flush();
      expect(reload).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + AUTO_REQUEST_MAX_AGE_MS + 1);
      navigated();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('checks again right before updating: text typed while it was asking the other tabs brings the dialog', async () => {
      stubLocks(2);
      otherTab(() => false);
      const { service, waiting } = setupWaiting(false);
      await flush();
      stubReload();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const decided = service.applyUpdate();
      await vi.advanceTimersByTimeAsync(OTHER_TABS_ANSWER_TIMEOUT_MS - 100);
      // A página segue usável durante a pergunta: a pessoa começa a digitar.
      busy = true;
      await vi.advanceTimersByTimeAsync(100);
      await decided;

      expect(service.confirmingUpdate()).toBe('mine');
      expect(service.updateDeciding()).toBe(false);
      expect(waiting.postMessage).not.toHaveBeenCalled();
    });

    it('after confirming only for another tab, asks again if this tab got unsaved text while it waited for writes', async () => {
      stubLocks(2);
      otherTab(() => true);
      const { service, waiting } = setupWaiting(false);
      await flush();
      stubReload();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

      await service.applyUpdate();
      expect(service.confirmingUpdate()).toBe('other-tab');
      // Um envio sai depois de o diálogo abrir; a confirmação espera por ele.
      const end = TestBed.inject(UnsavedWork).beginRequest();
      const confirmed = service.confirmUpdate();
      await vi.advanceTimersByTimeAsync(300);
      busy = true;
      end();
      await vi.advanceTimersByTimeAsync(200);
      await confirmed;

      expect(service.confirmingUpdate()).toBe('mine');
      expect(waiting.postMessage).not.toHaveBeenCalled();
    });

    it('keeps the button on "Atualizando…" through the whole decision, with no full-page skeleton and no flicker', async () => {
      stubLocks(2);
      otherTab(() => false);
      const { service } = setupWaiting();
      await flush();
      stubReload();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const end = TestBed.inject(UnsavedWork).beginRequest();
      const states: string[] = [];
      const look = () =>
        states.push(
          `${service.updateDeciding() || service.applyingUpdate() ? 'busy' : 'idle'}/${service.showSkeleton() ? 'skeleton' : 'none'}`,
        );

      const decided = service.applyUpdate();
      look();
      await vi.advanceTimersByTimeAsync(300);
      look();
      end();
      await vi.advanceTimersByTimeAsync(200);
      look();
      await vi.advanceTimersByTimeAsync(OTHER_TABS_ANSWER_TIMEOUT_MS);
      await decided;
      look();

      // Do toque até a troca começar o botão nunca volta a "Atualizar"; o esqueleto só vem com a troca de verdade.
      expect(states.slice(0, 3)).toEqual(['busy/none', 'busy/none', 'busy/none']);
      expect(states[3]).toBe('busy/skeleton');
    });

    describe('writes in flight', () => {
      function fakeClock() {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      }

      it('waits for them to finish instead of asking, and shows the update in progress meanwhile', async () => {
        const { service, waiting } = setupWaiting();
        await flush();
        stubReload();
        fakeClock();
        const end = TestBed.inject(UnsavedWork).beginRequest();

        const decided = service.applyUpdate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(service.confirmingUpdate()).toBeNull();
        expect(service.updateDeciding()).toBe(true);
        expect(service.showSkeleton()).toBe(false);
        expect(waiting.postMessage).not.toHaveBeenCalled();

        end();
        await vi.advanceTimersByTimeAsync(200);
        await decided;
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      });

      it('does not wait forever: after about 5 s it goes on', async () => {
        const { service, waiting } = setupWaiting();
        await flush();
        stubReload();
        fakeClock();
        TestBed.inject(UnsavedWork).beginRequest();

        const decided = service.applyUpdate();
        await vi.advanceTimersByTimeAsync(UPDATE_WRITES_WAIT_MS - 200);
        expect(waiting.postMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(400);
        await decided;
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      });

      it('asks again if the wait brought unsaved text back (a save that failed)', async () => {
        const { service, waiting } = setupWaiting(false);
        await flush();
        stubReload();
        fakeClock();
        const end = TestBed.inject(UnsavedWork).beginRequest();

        const decided = service.applyUpdate();
        await vi.advanceTimersByTimeAsync(300);
        // O pedido terminou com erro e o editor voltou a ficar sujo.
        busy = true;
        end();
        await vi.advanceTimersByTimeAsync(200);
        await decided;

        expect(service.confirmingUpdate()).toBe('mine');
        expect(service.updateDeciding()).toBe(false);
        expect(waiting.postMessage).not.toHaveBeenCalled();
      });

      it('after the person accepted losing one dirty editor, a different editor that turns dirty during the wait asks again', async () => {
        const { service, waiting } = setupWaiting(true);
        await flush();
        stubReload();
        fakeClock();

        await service.applyUpdate();
        expect(service.confirmingUpdate()).toBe('mine');
        const end = TestBed.inject(UnsavedWork).beginRequest();
        let another = false;
        TestBed.inject(UnsavedWork).register(() => another, 'form');
        const confirmed = service.confirmUpdate();
        await vi.advanceTimersByTimeAsync(300);
        another = true;
        end();
        await vi.advanceTimersByTimeAsync(200);
        await confirmed;

        expect(service.confirmingUpdate()).toBe('mine');
        expect(service.updateDeciding()).toBe(false);
        expect(waiting.postMessage).not.toHaveBeenCalled();
      });

      it('still asks when there is typed text, and that comes before waiting for writes', async () => {
        const { service } = setupWaiting(true);
        await flush();
        TestBed.inject(UnsavedWork).beginRequest();

        await tap(service);
        expect(service.confirmingUpdate()).toBe('mine');
      });

      it('also waits for them after the person confirmed losing the typed text', async () => {
        const { service, waiting } = setupWaiting(true);
        await flush();
        stubReload();
        fakeClock();
        const end = TestBed.inject(UnsavedWork).beginRequest();

        await service.applyUpdate();
        expect(service.confirmingUpdate()).toBe('mine');
        const confirmed = service.confirmUpdate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(service.confirmingUpdate()).toBeNull();
        expect(service.updateDeciding()).toBe(true);
        expect(waiting.postMessage).not.toHaveBeenCalled();

        end();
        await vi.advanceTimersByTimeAsync(200);
        await confirmed;
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      });
    });

    describe('when a navigation fails while the reload is deferred', () => {
      it('does not say "save or discard" when only a write is in flight, and reloads once it finishes', async () => {
        const { service } = setupWaiting(false);
        await flush();
        const { assign, reload } = stubAssign();
        const end = TestBed.inject(UnsavedWork).beginRequest();

        expect(service.recoverFromStaleShell('/treino/rotinas')).toBe(true);
        await flush();
        expect(service.navigationBlocked()).toBe(false);
        expect(reload).not.toHaveBeenCalled();

        // Nenhuma outra tentativa de navegar: a própria volta da escrita dispara a recarga adiada.
        end();
        await flush();
        // A recarga vai direto à rota que falhou, como se a pessoa tivesse tentado de novo.
        expect(assign).toHaveBeenCalledWith('/treino/rotinas');
        expect(reload).not.toHaveBeenCalled();
      });

      it('does not pile up waits when several navigations fail during the same write', async () => {
        const { service } = setupWaiting(false);
        await flush();
        const reload = stubReload();
        const end = TestBed.inject(UnsavedWork).beginRequest();

        service.recoverFromStaleShell();
        await flush();
        service.recoverFromStaleShell();
        await flush();
        end();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('says so instead of swallowing it, and clears the message once a navigation works again', async () => {
        const { service } = setupWaiting(true);
        await flush();
        stubReload();

        expect(service.recoverFromStaleShell('/treino/rotinas')).toBe(true);
        await flush();
        expect(service.navigationBlocked()).toBe(true);
        expect(service.updateReady()).toBe(true);

        navigated();
        await flush();
        expect(service.navigationBlocked()).toBe(false);

        // A pessoa tenta outra rota que também some: o aviso volta.
        service.recoverFromStaleShell('/treino/exercicios');
        await flush();
        expect(service.navigationBlocked()).toBe(true);
      });

      it('shows nothing of the sort when the tab is clean and just reloads', async () => {
        const { service } = setupWaiting(false);
        await flush();
        const reload = stubReload();

        service.recoverFromStaleShell();
        await flush();

        expect(reload).toHaveBeenCalledTimes(1);
        expect(service.navigationBlocked()).toBe(false);
      });
    });

    it('shows the notice, without reloading again, when a second worker change comes inside the guard window', async () => {
      const { container, service } = setupWaiting(false);
      await flush();
      const reload = stubReload();
      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      service.updateReady.set(false);
      // A página de verdade teria sido trocada; aqui a mesma instância segue viva para a segunda troca.
      Object.assign(service, { reloading: false });

      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(service.updateReady()).toBe(true);
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
      // O último recurso do vigia exige uma aba só.
      stubLocks(1);
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
