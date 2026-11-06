import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { type AskTab, swapIfSafe } from '../../../sw-swap-gate';
import {
  AUTO_RECOVERY_GUARD_MS,
  CHUNK_RECOVERY_KEY,
  FIRST_CONTENT_WATCHDOG_MS,
  IDLE_SWAP_KEY,
  PWA_ENABLED,
  PwaUpdateService,
  UPDATE_ACTIVATE_TIMEOUT_MS,
  UPDATE_CACHE_CLEAR_TIMEOUT_MS,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_FLAG_MAX_AGE_MS,
  UPDATE_INSTALL_TIMEOUT_MS,
  UPDATE_REFRESHING_KEY,
  UPDATE_SWAP_ASK_TIMEOUT_MS,
  UPDATE_WATCHDOG_KEY,
} from './pwa-update.service';
import { registerServiceWorker } from './register-sw';
import { UnsavedWork } from './unsaved-work';

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

  describe('with unsaved work', () => {
    let busy = false;
    const realChannel = window.MessageChannel;

    class FakeChannel {
      static last: FakeChannel | undefined;
      readonly port1: {
        onmessage: ((event: { data: unknown }) => void) | null;
        close: () => void;
      } = { onmessage: null, close: vi.fn() };
      readonly port2 = {};
      constructor() {
        FakeChannel.last = this;
      }
    }

    afterEach(() => {
      Object.defineProperty(window, 'MessageChannel', { value: realChannel, configurable: true });
    });

    /** Uma navegação concluída (o serviço escuta o roteador sozinho). */
    function navigated() {
      (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
        new NavigationEnd(1, '/a', '/a'),
      );
    }

    /**
     * Faz o papel do worker que espera: reúne as abas (esta e as `otherTabs`), pergunta com o mesmo \`swapIfSafe\` do worker
     * real e, trocando, assume as abas (\`controllerchange\`). Devolve as mensagens que o worker recebeu.
     */
    function actAsWorker(worker: FakeWorker, container: EventTarget, otherTabs: AskTab[] = []) {
      Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true });
      const received: string[] = [];
      worker.postMessage.mockImplementation((message: { type: string }) => {
        received.push(message.type);
        if (message.type !== 'SWAP_IF_SAFE') return;
        const channel = FakeChannel.last!;
        const unsaved = TestBed.inject(UnsavedWork);
        void swapIfSafe(
          [async () => unsaved.hasUnsaved(), ...otherTabs],
          async () => undefined,
        ).then((verdict) => {
          channel.port1.onmessage?.({ data: verdict });
          if (verdict === 'swapped') container.dispatchEvent(new Event('controllerchange'));
        });
      });
      return received;
    }

    function setupBusy(initial = true) {
      busy = initial;
      const made = setup({});
      TestBed.inject(UnsavedWork).register(() => busy);
      const waiting = new FakeWorker();
      made.registration.waiting = waiting;
      const received = actAsWorker(waiting, made.container);
      return { ...made, waiting, received };
    }

    it('defers an automatic recovery: no swap request, no reload, notice visible, guard untouched', async () => {
      const { service, received } = setupBusy();
      await flush();
      const reload = stubReload();

      expect(service.recoverFromStaleShell('/treino')).toBe(true);
      await flush();

      expect(received).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
      expect(service.showSkeleton()).toBe(false);
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
    });

    it('has no clock: it waits for a safe moment, and a new try to navigate is one', async () => {
      const { service, received } = setupBusy();
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
      expect(received).toEqual(['SWAP_IF_SAFE']);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/treino');
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).not.toBeNull();
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

    it('never reloads over text typed in a real field, and goes on once it is gone', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.value = 'Supino 3x10';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(service.recoverFromStaleShell()).toBe(true);
      navigated();
      await flush();
      expect(reload).not.toHaveBeenCalled();

      input.remove();
      navigated();
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

    it('lets the tap on the notice update at once with a plain SKIP_WAITING, even with work pending', async () => {
      const { service, container, waiting } = setupBusy();
      await flush();
      const reload = stubReload();

      service.applyUpdate();
      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('stops waiting once the person taps the notice', async () => {
      const { service, container } = setupBusy();
      await flush();
      const reload = stubReload();
      service.recoverFromStaleShell();
      service.applyUpdate();
      container.dispatchEvent(new Event('controllerchange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      busy = false;
      navigated();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    describe('several tabs', () => {
      it('does not swap while ANOTHER tab has work: nothing changes and the notice stays', async () => {
        busy = false;
        const made = setup({});
        const waiting = new FakeWorker();
        made.registration.waiting = waiting;
        let otherBusy = true;
        const received = actAsWorker(waiting, made.container, [async () => otherBusy]);
        const caches = stubCaches(['runtime-x']);
        await flush();
        const reload = stubReload();
        const controllerChanged = vi.fn();
        made.container.addEventListener('controllerchange', controllerChanged);

        made.service.recoverFromStaleShell('/treino');
        await flush();

        expect(received).toEqual(['SWAP_IF_SAFE']);
        expect(controllerChanged).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(caches.delete).not.toHaveBeenCalled();
        expect(made.registration.unregister).not.toHaveBeenCalled();
        expect(made.service.applyingUpdate()).toBe(false);
        expect(made.service.updateReady()).toBe(true);

        otherBusy = false;
        navigated();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('treats a tab that does not answer as busy', async () => {
        busy = false;
        const made = setup({});
        const waiting = new FakeWorker();
        made.registration.waiting = waiting;
        actAsWorker(waiting, made.container, [async () => undefined]);
        await flush();
        const reload = stubReload();

        made.service.recoverFromStaleShell();
        await flush();
        expect(reload).not.toHaveBeenCalled();
        expect(made.service.updateReady()).toBe(true);
      });

      it('does not swap when the worker never answers, or when MessageChannel is missing', async () => {
        const { service, waiting } = setupBusy(false);
        waiting.postMessage.mockImplementation(() => undefined);
        Object.defineProperty(window, 'MessageChannel', {
          value: FakeChannel,
          configurable: true,
        });
        await flush();
        const reload = stubReload();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        service.recoverFromStaleShell();
        await vi.advanceTimersByTimeAsync(UPDATE_SWAP_ASK_TIMEOUT_MS);
        expect(reload).not.toHaveBeenCalled();
        expect(service.updateReady()).toBe(true);
        vi.useRealTimers();

        TestBed.resetTestingModule();
        sessionStorage.clear();
        const second = setupBusy(false);
        Object.defineProperty(window, 'MessageChannel', { value: undefined, configurable: true });
        await flush();
        second.service.recoverFromStaleShell();
        await flush();
        expect(second.received).toEqual([]);
        expect(reload).not.toHaveBeenCalled();
      });

      it('tells the worker the truth when it asks this tab whether it has work', async () => {
        const { container } = setup({});
        await flush();
        const ask = () => {
          const postMessage = vi.fn();
          const event = Object.assign(new Event('message'), {
            data: { type: 'ARE_YOU_BUSY' },
            ports: [{ postMessage }],
          });
          container.dispatchEvent(event);
          return postMessage;
        };
        expect(ask()).toHaveBeenCalledWith({ busy: false });
        const end = TestBed.inject(UnsavedWork).beginRequest();
        expect(ask()).toHaveBeenCalledWith({ busy: true });
        end();
        const ignored = vi.fn();
        container.dispatchEvent(
          Object.assign(new Event('message'), {
            data: { type: 'OTHER' },
            ports: [{ postMessage: ignored }],
          }),
        );
        expect(ignored).not.toHaveBeenCalled();
      });

      it('once the worker swapped, the tab never backs out of the reload (no old shell under the new worker)', async () => {
        const { service, container } = setupBusy(false);
        await flush();
        const reload = stubReload();
        // A pessoa começa a digitar no instante em que o worker novo assume.
        container.addEventListener('controllerchange', () => {
          busy = true;
        });

        service.recoverFromStaleShell();
        await flush();

        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('never backs out after the stale worker was dropped, and registers again if the reload fails', async () => {
        stubFetch();
        const { service, container, registration, waiting } = setupBusy(false);
        await flush();
        // O worker aceita a troca mas nunca assume: no prazo, o último recurso desfaz o registro.
        waiting.postMessage.mockImplementation(() => {
          FakeChannel.last!.port1.onmessage?.({ data: 'swapped' });
        });
        Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true });
        let slowStep = 0;
        registration.unregister.mockImplementation(() => {
          // Trabalho aparece justo depois de o registro ser desfeito: a recarga segue assim mesmo.
          busy = true;
          slowStep++;
          return Promise.resolve(true);
        });
        vi.spyOn(window, 'location', 'get').mockReturnValue({
          ...window.location,
          reload: () => {
            throw new Error('bloqueado');
          },
        } as Location);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        service.recoverFromStaleShell();
        await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS + 1);
        await vi.advanceTimersByTimeAsync(UPDATE_CACHE_CLEAR_TIMEOUT_MS);
        vi.useRealTimers();
        await flush();

        expect(slowStep).toBe(1);
        expect(service.updateError()).toBe(true);
        // O registro foi desfeito e a recarga falhou: o serviço registra de novo para o app não ficar sem worker.
        expect(container.register).toHaveBeenCalledTimes(2);
      });

      it('registers again on the next check once the registration was dropped', async () => {
        stubFetch();
        const { service, container, waiting } = setupBusy(false);
        await flush();
        waiting.postMessage.mockImplementation(() => {
          FakeChannel.last!.port1.onmessage?.({ data: 'swapped' });
        });
        Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true });
        stubReload();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        service.recoverFromStaleShell();
        await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS + 1);
        vi.useRealTimers();
        await flush();
        expect(container.register).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new Event('online'));
        await flush();
        expect(container.register).toHaveBeenCalledTimes(2);
      });
    });

    it('from the load watchdog: waits instead of reloading, frees the screen and keeps its own loop guard', async () => {
      sessionStorage.setItem(UPDATE_REFRESHING_KEY, String(Date.now()));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      TestBed.configureTestingModule({ providers: [{ provide: PWA_ENABLED, useValue: false }] });
      const service = TestBed.inject(PwaUpdateService);
      busy = true;
      TestBed.inject(UnsavedWork).register(() => busy, 'outbox');
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
      // A guarda gravada é a do vigia (não a do pedaço ausente): a página seguinte não repete o ciclo.
      expect(sessionStorage.getItem(UPDATE_WATCHDOG_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(CHUNK_RECOVERY_KEY)).toBeNull();
    });
  });

  describe('atomic service worker swap', () => {
    const realChannel = window.MessageChannel;

    class FakeChannel {
      static last: FakeChannel | undefined;
      readonly port1: {
        onmessage: ((event: { data: unknown }) => void) | null;
        close: () => void;
      } = { onmessage: null, close: vi.fn() };
      readonly port2 = {};
      constructor() {
        FakeChannel.last = this;
      }
    }

    afterEach(() => {
      Object.defineProperty(window, 'MessageChannel', { value: realChannel, configurable: true });
    });

    async function waitingUpdate(busy: () => boolean = () => false) {
      const made = setup({});
      TestBed.inject(UnsavedWork).register(busy);
      Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true });
      await flush();
      const waiting = new FakeWorker();
      waiting.state = 'installed';
      const received: string[] = [];
      waiting.postMessage.mockImplementation((message: { type: string }) => {
        received.push(message.type);
        if (message.type !== 'SWAP_IF_SAFE') return;
        const channel = FakeChannel.last!;
        void swapIfSafe(
          [async () => TestBed.inject(UnsavedWork).hasUnsaved()],
          async () => undefined,
        ).then((verdict) => {
          channel.port1.onmessage?.({ data: verdict });
          if (verdict === 'swapped') made.container.dispatchEvent(new Event('controllerchange'));
        });
      });
      made.registration.waiting = waiting;
      made.registration.dispatchEvent(new Event('updatefound'));
      made.service.updateReady.set(true);
      return { ...made, waiting, received };
    }

    function navigated() {
      (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
        new NavigationEnd(1, '/a', '/a'),
      );
    }

    it('never activates a waiting worker on its own: not on load, update found, coming back online or visibility', async () => {
      const { registration, waiting, received, container } = await waitingUpdate();
      const controllerChanged = vi.fn();
      container.addEventListener('controllerchange', controllerChanged);
      registration.dispatchEvent(new Event('updatefound'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('load'));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(received).toEqual([]);
      expect(waiting.postMessage).not.toHaveBeenCalled();
      expect(controllerChanged).not.toHaveBeenCalled();
    });

    it('does nothing on a navigation when there is no new version waiting', async () => {
      const { service } = setup({});
      await flush();
      const reload = stubReload();
      navigated();
      await flush();
      expect(service.updateReady()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(IDLE_SWAP_KEY)).toBeNull();
    });

    it('swaps (after asking every tab) and reloads on a navigation when everything is idle', async () => {
      const { received } = await waitingUpdate();
      const reload = stubReload();
      navigated();
      await flush();
      expect(received).toEqual(['SWAP_IF_SAFE']);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('leaves the notice up and the worker untouched on a navigation with unsaved work', async () => {
      const { service, received } = await waitingUpdate(() => true);
      const reload = stubReload();
      navigated();
      await flush();
      expect(received).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
      expect(sessionStorage.getItem(IDLE_SWAP_KEY)).toBeNull();
    });

    it('tries only once per guard window, so a swap that fails never loops', async () => {
      const { service, received } = await waitingUpdate();
      const reload = stubReload();
      navigated();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);

      // A recarga não aconteceu de verdade neste ambiente: a mesma instância navega de novo dentro da janela.
      Object.assign(service, { reloading: false, applying: false });
      received.length = 0;
      navigated();
      await flush();
      expect(received).toEqual([]);
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
