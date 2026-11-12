import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import {
  AUTO_APPLY_GUARD_MS,
  AUTO_APPLY_KEY,
  AUTO_APPLY_UPDATES,
  PWA_ENABLED,
  PwaUpdateService,
  TAB_LOCK_NAME,
  UPDATE_ACTIVATE_TIMEOUT_MS,
  UPDATE_CACHE_CLEAR_TIMEOUT_MS,
  UPDATE_POLL_MS,
} from './pwa-update.service';
import { LIST_CLIENTS_TIMEOUT_MS } from './sw-clients';
import { OTHER_TABS_STRICT_TIMEOUT_MS, answerTabBusyQueries } from './tab-busy';
import { installFakeMessageChannel } from './sw-clients-test-kit';
import { installFakeBroadcastChannel } from './tab-busy-test-kit';
import { UnsavedWork } from './unsaved-work';

class FakeWorker extends EventTarget {
  state = 'installed';
  /** Janelas do app que o worker diz existir (a desta aba entre elas); `null`: não responde à pergunta. */
  windows: number | null = 1;
  selfListed = true;
  /** A pergunta "quantas janelas existem" (a lista autoritativa do worker). */
  readonly asked = vi.fn();
  /** Só os pedidos de troca (`SKIP_WAITING`). */
  readonly skips = vi.fn();

  postMessage(message: { type: string }, transfer?: unknown[]): void {
    if (message.type !== 'LIST_CLIENTS') {
      this.skips(message);
      return;
    }
    this.asked();
    if (this.windows === null) return;
    (transfer?.[0] as { postMessage(data: unknown): void }).postMessage({
      type: 'CLIENTS',
      count: this.windows,
      selfListed: this.selfListed,
    });
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn().mockResolvedValue(undefined);
  unregister = vi.fn().mockResolvedValue(true);
}

const flush = () => new Promise((resolve) => setTimeout(resolve));
/** A troca decide em passos assíncronos (abas, escritas): deixa todos correrem. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

/**
 * A troca automática do worker novo: sem toque e sem esperar a pessoa parar, mas só num momento seguro (próxima navegação ou
 * aba indo para segundo plano) e nunca sobre trabalho em curso, aqui ou noutra aba.
 */
describe('PwaUpdateService: troca automática do worker', () => {
  const realFetch = window.fetch;
  let restoreMessageChannel: () => void;

  beforeEach(() => {
    restoreMessageChannel = installFakeMessageChannel();
  });

  afterEach(() => {
    restoreMessageChannel();
    Object.defineProperty(window, 'fetch', { value: realFetch, configurable: true });
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
    Reflect.deleteProperty(window, 'caches');
    Reflect.deleteProperty(window.navigator, 'locks');
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stubLocks(held: number) {
    const locks = {
      request: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        held: Array.from({ length: held }, () => ({ name: TAB_LOCK_NAME })),
        pending: [],
      }),
    };
    Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
  }

  /** Aba aberta sob um worker (`controller`) com outro esperando, como logo depois de um deploy. */
  function setup(
    options: { autoApply?: boolean; waiting?: boolean; controller?: object | null } = {},
  ) {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker();
    if (options.waiting !== false) registration.waiting = waiting;
    const container = Object.assign(new EventTarget(), {
      controller: options.controller === undefined ? {} : options.controller,
      register: vi.fn().mockResolvedValue(registration),
    });
    Object.defineProperty(window.navigator, 'serviceWorker', {
      value: container,
      configurable: true,
    });
    stubLocks(1);
    TestBed.configureTestingModule({
      providers: [
        { provide: PWA_ENABLED, useValue: true },
        { provide: AUTO_APPLY_UPDATES, useValue: options.autoApply ?? true },
      ],
    });
    const service = TestBed.inject(PwaUpdateService);
    service.start();
    return { registration, container, service, waiting, unsaved: TestBed.inject(UnsavedWork) };
  }

  function navigate(): void {
    (TestBed.inject(Router).events as unknown as Subject<unknown>).next(
      new NavigationEnd(1, '/a', '/a'),
    );
  }

  /** A abertura do app (a primeira navegação) não é um momento de troca. */
  async function booted() {
    const made = setup();
    await flush();
    navigate();
    await settle();
    return made;
  }

  function stubReload() {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    return reload;
  }

  function visibility(state: 'visible' | 'hidden') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  }

  /** Deixa o worker novo assumir a página (o `controllerchange` que o navegador entrega depois do `SKIP_WAITING`). */
  async function takeOver(container: EventTarget) {
    container.dispatchEvent(new Event('controllerchange'));
    await settle();
  }

  describe('na próxima navegação concluída', () => {
    it('ignores the opening navigation and swaps on the next one, with the page clean', async () => {
      const { container, waiting, service } = await booted();
      const reload = stubReload();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);

      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      await takeOver(container);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(AUTO_APPLY_KEY)).not.toBeNull();
    });

    it('does nothing when no worker is waiting', async () => {
      const made = setup({ waiting: false });
      await flush();
      navigate();
      navigate();
      await settle();
      expect(made.service.updateReady()).toBe(false);
      expect(made.waiting.skips).not.toHaveBeenCalled();
    });

    it('does nothing on the first install (no worker was in control before)', async () => {
      const made = setup({ controller: null });
      await flush();
      navigate();
      navigate();
      await settle();
      expect(made.waiting.skips).not.toHaveBeenCalled();
    });

    it('does nothing when the rule is switched off, leaving the tap and the cold open', async () => {
      const made = setup({ autoApply: false });
      await flush();
      navigate();
      navigate();
      await settle();
      expect(made.waiting.skips).not.toHaveBeenCalled();
      expect(made.service.updateReady()).toBe(true);
    });

    it('does not swap again inside the guard window, so a swap that did not take never loops', async () => {
      const { waiting } = await booted();
      sessionStorage.setItem(AUTO_APPLY_KEY, String(Date.now()));
      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('swaps again once the guard window has passed', async () => {
      const { waiting } = await booted();
      sessionStorage.setItem(AUTO_APPLY_KEY, String(Date.now() - AUTO_APPLY_GUARD_MS - 1));
      stubReload();
      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it('never retries by itself after an update that did not finish: only the tap on "Tentar de Novo" does', async () => {
      // A guarda da troca automática segura a primeira navegação: o pedido de troca vem só do toque.
      const { waiting, service } = await booted();
      const reload = stubReload();
      // A rede não responde: o worker novo não assume e o registro não pode ser desfeito.
      Object.defineProperty(window, 'fetch', {
        value: vi.fn().mockResolvedValue({ ok: false }),
        configurable: true,
      });
      sessionStorage.setItem(AUTO_APPLY_KEY, String(Date.now()));
      vi.useFakeTimers();
      await service.applyUpdate();
      await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATE_TIMEOUT_MS + UPDATE_CACHE_CLEAR_TIMEOUT_MS);
      expect(service.updateError()).toBe(true);
      expect(waiting.skips).toHaveBeenCalledTimes(1);

      // Passada a janela da guarda, nem a navegação nem a aba indo para o fundo pedem a troca de novo.
      await vi.advanceTimersByTimeAsync(AUTO_APPLY_GUARD_MS + 1);
      navigate();
      await vi.advanceTimersByTimeAsync(5_000);
      visibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(waiting.skips).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(service.updateError()).toBe(true);
    });
  });

  describe('com trabalho em curso nesta aba', () => {
    it('waits while an editor is dirty and swaps on the first navigation after it is clean', async () => {
      const { waiting, unsaved, service } = await booted();
      let dirty = true;
      unsaved.register(() => dirty);
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
      expect(service.confirmingUpdate()).toBeNull();

      dirty = false;
      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it.each(['session', 'sync'] as const)('waits while the %s is in use', async (reason) => {
      const { waiting, unsaved } = await booted();
      let inUse = true;
      unsaved.register(() => inUse, reason);
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();

      inUse = false;
      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it('waits for a write in flight', async () => {
      const { waiting, unsaved } = await booted();
      const end = unsaved.beginRequest();
      stubReload();
      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
      end();
      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it('re-checks right before swapping: work that appears while asking the other tabs holds the swap', async () => {
      const { waiting, unsaved } = await booted();
      let busy = false;
      unsaved.register(() => busy);
      stubReload();
      // A consulta às outras abas é assíncrona (Web Locks): o trabalho aparece no meio dela.
      const query = vi.fn().mockImplementation(() => {
        busy = true;
        return Promise.resolve({ held: [{ name: TAB_LOCK_NAME }], pending: [] });
      });
      Object.defineProperty(window.navigator, 'locks', {
        value: { request: vi.fn().mockResolvedValue(undefined), query },
        configurable: true,
      });
      navigate();
      await settle();
      expect(query).toHaveBeenCalled();
      expect(waiting.skips).not.toHaveBeenCalled();
    });
  });

  describe('com a aba indo para segundo plano', () => {
    it('swaps when the tab goes hidden and nothing is in progress', async () => {
      const { container, waiting } = await booted();
      const reload = stubReload();
      visibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expect(waiting.skips).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      await takeOver(container);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('holds the swap while an editor is dirty even in the background', async () => {
      const { waiting, unsaved } = await booted();
      unsaved.register(() => true);
      visibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('does not swap when the tab comes back to the foreground', async () => {
      const { waiting } = await booted();
      visibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('swaps right away when the new worker arrives while the tab is already in the background', async () => {
      visibility('hidden');
      const { waiting } = setup();
      await settle();
      expect(waiting.skips).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    });
  });

  describe('com outras abas abertas', () => {
    let restoreChannel: () => void;
    const stops: (() => void)[] = [];

    beforeEach(() => {
      restoreChannel = installFakeBroadcastChannel();
    });

    afterEach(() => {
      for (const stop of stops.splice(0)) stop();
      restoreChannel();
    });

    it('holds the swap when another tab has any work in progress, even one that never asks for confirmation', async () => {
      // A outra aba só tem um treino aberto: não pede confirmação (toque), mas a troca automática espera.
      stops.push(answerTabBusyQueries(window, (strict) => strict, 'tab-b'));
      const { waiting, service } = await booted();
      waiting.windows = 2;
      stubLocks(2);
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
    });

    it('holds the swap with other tabs open even when each says it is free (one could start work before the swap)', async () => {
      stops.push(answerTabBusyQueries(window, () => false, 'tab-b'));
      stops.push(answerTabBusyQueries(window, () => false, 'tab-c'));
      const { waiting, service } = await booted();
      waiting.windows = 3;
      stubLocks(3);
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
    });

    it('holds the swap when one of the other tabs stays silent (frozen in the background, or of an older version)', async () => {
      stops.push(answerTabBusyQueries(window, () => false, 'tab-b'));
      const { waiting, service } = await booted();
      // Três janelas existem, só uma outra responde.
      waiting.windows = 3;
      stubLocks(3);
      stubReload();

      navigate();
      await new Promise((resolve) => setTimeout(resolve, OTHER_TABS_STRICT_TIMEOUT_MS + 200));
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
    });

    it('holds the swap without BroadcastChannel when another tab is open', async () => {
      const { waiting } = await booted();
      waiting.windows = 2;
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
      stubLocks(2);
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('holds the swap for a window of an older version that holds no tab lock and cannot answer: the worker sees it, the lock count does not', async () => {
      const { waiting, service } = await booted();
      // Só esta aba segura o bloqueio (a outra é de antes dele, com um formulário sujo), mas o worker conta duas janelas.
      waiting.windows = 2;
      stubLocks(1);
      stubReload();

      navigate();
      await new Promise((resolve) => setTimeout(resolve, OTHER_TABS_STRICT_TIMEOUT_MS + 200));
      expect(waiting.asked).toHaveBeenCalled();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);
    });

    it('uses the larger of the worker count and the lock count', async () => {
      const { waiting } = await booted();
      waiting.windows = 1;
      stubLocks(2);
      stubReload();

      navigate();
      await new Promise((resolve) => setTimeout(resolve, OTHER_TABS_STRICT_TIMEOUT_MS + 200));
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('swaps with no Web Locks at all when the worker says this is the only window', async () => {
      const { waiting } = await booted();
      Reflect.deleteProperty(window.navigator, 'locks');
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it('holds the swap when the waiting worker does not answer (a version that does not understand the question), and the tap still goes through', async () => {
      const { waiting, service } = await booted();
      waiting.windows = null;
      stubReload();

      navigate();
      await new Promise((resolve) => setTimeout(resolve, LIST_CLIENTS_TIMEOUT_MS + 200));
      expect(waiting.asked).toHaveBeenCalled();
      expect(waiting.skips).not.toHaveBeenCalled();
      expect(service.updateReady()).toBe(true);

      await service.applyUpdate();
      expect(waiting.skips).toHaveBeenCalledTimes(1);
    });

    it('holds the swap when the worker does not list this window, since the count cannot be trusted', async () => {
      const { waiting } = await booted();
      waiting.selfListed = false;
      stubReload();

      navigate();
      await settle();
      expect(waiting.skips).not.toHaveBeenCalled();
    });

    it('holds the swap without MessageChannel, as nothing can ask the worker', async () => {
      const { waiting } = await booted();
      Reflect.deleteProperty(window, 'MessageChannel');
      stubReload();

      navigate();
      await settle();
      expect(waiting.asked).not.toHaveBeenCalled();
      expect(waiting.skips).not.toHaveBeenCalled();
    });
  });

  describe('a busca de versão nova', () => {
    /** Os temporizadores falsos entram antes do serviço: é ele quem arma o intervalo. */
    async function pollingSetup() {
      vi.useFakeTimers();
      const made = setup({ waiting: false });
      await vi.advanceTimersByTimeAsync(0);
      made.registration.update.mockClear();
      return made;
    }

    it('repeats while the tab is in the foreground, so a tab left open all day still finds the new version', async () => {
      const { registration } = await pollingSetup();
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
      expect(registration.update).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
      expect(registration.update).toHaveBeenCalledTimes(2);
    });

    it('skips the search while the tab is hidden', async () => {
      const { registration } = await pollingSetup();
      visibility('hidden');
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
      expect(registration.update).not.toHaveBeenCalled();
    });

    it('stops searching when the app is torn down', async () => {
      const { registration } = await pollingSetup();
      TestBed.resetTestingModule();
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS * 2);
      expect(registration.update).not.toHaveBeenCalled();
    });
  });

  describe('o aviso quando a navegação não acontece', () => {
    it('says the new version waits when only a session or the queue is in use (nothing to save)', async () => {
      const { service, unsaved } = setup({ waiting: false });
      await flush();
      stubReload();
      let inUse = true;
      unsaved.register(() => inUse, 'session');

      // Um pedaço de código que sumiu com o treino aberto: a recarga espera e o aviso diz por quê.
      expect(service.recoverFromStaleShell('/treino/hoje')).toBe(true);
      await settle();
      expect(service.updateReady()).toBe(true);
      expect(service.navigationHeld()).toBe(true);
      expect(service.navigationBlocked()).toBe(false);

      // O toque não pergunta nada por causa do treino: ele fica gravado no aparelho.
      expect(unsaved.needsConfirmation()).toBe(false);

      inUse = false;
      navigate();
      await settle();
      expect(service.navigationHeld()).toBe(false);
    });

    it('keeps asking to save or discard when there is a dirty editor, not the held notice', async () => {
      const { service, unsaved } = setup({ waiting: false });
      await flush();
      unsaved.register(() => true);
      expect(service.recoverFromStaleShell('/treino/hoje')).toBe(true);
      await settle();
      expect(service.navigationBlocked()).toBe(true);
      expect(service.navigationHeld()).toBe(false);
    });
  });
});
