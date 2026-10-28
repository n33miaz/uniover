import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, computed, inject, isDevMode, signal } from '@angular/core';
import { registerServiceWorker } from './register-sw';

/** Liga o service worker só fora do modo de desenvolvimento; os testes trocam este valor. */
export const PWA_ENABLED = new InjectionToken<boolean>('PWA_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

/** Quanto se espera a instalação de um worker novo quando nenhum estava esperando (a rede pode ser lenta). */
export const UPDATE_INSTALL_TIMEOUT_MS = 8_000;
/** Quanto se espera o worker novo assumir a página depois do pedido; passado isso, recarrega mesmo assim. */
export const UPDATE_ACTIVATE_TIMEOUT_MS = 8_000;
/** Limpar caches não pode segurar a atualização: passado este prazo, segue para a recarga. */
export const UPDATE_CACHE_CLEAR_TIMEOUT_MS = 3_000;
export const UPDATE_CHECK_THROTTLE_MS = 60_000;
/**
 * Depois de uma atualização, quanto a casca nova tem para mostrar o primeiro conteúdo antes de recarregar de novo. Fica bem
 * acima da espera do guarda de entrada (3 s pela API, que pode estar acordando) mais o download dos pedaços da tela: uma rede
 * lenta não é defeito da casca, e recarregar não a acelera.
 */
export const FIRST_CONTENT_WATCHDOG_MS = 10_000;
/** A marca de "acabei de atualizar" só vale por este tempo (uma aba reaberta depois não é uma atualização). */
export const UPDATE_FLAG_MAX_AGE_MS = 60_000;
/** Depois de uma recuperação automática, outra só vale passada esta janela: nunca há laço de recarga. */
export const AUTO_RECOVERY_GUARD_MS = 60_000;

/** Chaves do `sessionStorage` (por aba): a marca de atualização em curso e as guardas contra laço. */
export const UPDATE_REFRESHING_KEY = 'uniover.update.refreshing';
export const UPDATE_WATCHDOG_KEY = 'uniover.update.watchdog';
export const CHUNK_RECOVERY_KEY = 'uniover.update.chunk-recovery';

/** Caches que a limpeza nunca apaga: o precache (a casca atual, para funcionar offline) e a arte dos exercícios. */
function isProtectedCache(name: string): boolean {
  return name.startsWith('workbox-precache') || name === 'exercise-art';
}

// O `sessionStorage` pode faltar ou lançar (modo privado, armazenamento bloqueado): tudo aqui degrada para "sem marca".
function readStamp(win: Window, key: string): number | null {
  try {
    const value = Number(win.sessionStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStamp(win: Window, key: string): void {
  try {
    win.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Sem armazenamento a guarda não se lembra; o prazo e o `reloading` ainda limitam a recarga da própria página.
  }
}

function removeKey(win: Window, key: string): void {
  try {
    win.sessionStorage.removeItem(key);
  } catch {
    // Nada a limpar.
  }
}

function guardActive(win: Window, key: string, windowMs: number): boolean {
  const at = readStamp(win, key);
  return at !== null && Date.now() - at < windowMs;
}

/**
 * Cuida do ciclo de vida do service worker: registra, avisa quando há versão nova esperando e, quando o
 * usuário aceita, troca de verdade: espera o worker novo assumir a página, limpa os caches de execução que podem ter
 * conteúdo velho e só então recarrega, uma vez. O mesmo caminho serve para se recuperar de uma casca antiga que pede
 * um pedaço de código que já não existe (ver `chunk-error.ts`).
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly enabled = inject(PWA_ENABLED);
  private registration: ServiceWorkerRegistration | undefined;
  private started = false;
  private registering = false;
  private applying = false;
  private reloading = false;
  private lastUpdateCheckAt: number | null = null;
  private watchdogTimer: number | undefined;
  /** Para onde a recarga vai quando a recuperação nasceu de uma navegação que falhou (senão, recarrega onde está). */
  private resumeUrl: string | undefined;
  private readonly watchedWorkers = new WeakSet<ServiceWorker>();
  private readonly bootRefreshing = signal(false);

  readonly updateReady = signal(false);
  readonly applyingUpdate = signal(false);
  readonly updateError = signal(false);
  /**
   * O esqueleto de página inteira fica de pé do toque em "Atualizar" até o primeiro conteúdo da página nova (a recarga
   * recomeça o app, então a marca atravessa a recarga pelo `sessionStorage`).
   */
  readonly showSkeleton = computed(() => this.applyingUpdate() || this.bootRefreshing());

  constructor() {
    const win = this.win;
    if (!win) return;
    const at = readStamp(win, UPDATE_REFRESHING_KEY);
    removeKey(win, UPDATE_REFRESHING_KEY);
    if (at !== null && Date.now() - at < UPDATE_FLAG_MAX_AGE_MS) {
      this.bootRefreshing.set(true);
      this.watchdogTimer = win.setTimeout(
        () => this.firstContentLate(win),
        FIRST_CONTENT_WATCHDOG_MS,
      );
    }
  }

  /** Chamado na inicialização do app; não bloqueia a primeira tela. */
  start(): void {
    const win = this.win;
    if (this.started || !win || !this.enabled) return;
    this.started = true;
    const run = () => this.checkForUpdate(win);
    if (win.document.readyState === 'complete') run();
    else win.addEventListener('load', run, { once: true });
    // Uma primeira tentativa offline não impede a próxima: a conexão e a volta à aba são novas oportunidades.
    win.addEventListener('online', run);
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') run();
    });
  }

  /** O usuário aceitou a versão nova: troca a casca de verdade e sempre termina recarregando a página. */
  applyUpdate(): void {
    if (this.applying) return;
    this.updateError.set(false);
    void this.refresh();
  }

  /**
   * Uma rota ou importação falhou porque o pedaço de código não existe mais (a casca aberta é de uma versão que o
   * servidor já trocou). Atualiza pelo mesmo caminho do botão, no máximo uma vez por janela (a guarda no
   * `sessionStorage` impede laço). `target` é a rota que o usuário tentava abrir: o roteador volta ao endereço anterior
   * quando a navegação falha, então a recarga vai direto ao alvo em vez de largá-lo na tela de antes. Devolve `true` se há uma recuperação em curso (ou começou agora) e `false` se a guarda
   * a negou, para o erro seguir o caminho normal.
   */
  recoverFromStaleShell(target?: string): boolean {
    if (this.applying) return true;
    const win = this.win;
    if (!win || guardActive(win, CHUNK_RECOVERY_KEY, AUTO_RECOVERY_GUARD_MS)) return false;
    writeStamp(win, CHUNK_RECOVERY_KEY);
    // Só caminhos do próprio app: nada de `//host` nem de esquema.
    if (target && /^\/(?!\/)/.test(target)) this.resumeUrl = target;
    void this.refresh();
    return true;
  }

  /** A primeira página real da casca nova apareceu: o esqueleto pode sair e o vigia da carga é desarmado. */
  markContentReady(): void {
    if (!this.bootRefreshing()) return;
    if (this.watchdogTimer !== undefined) this.win?.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.bootRefreshing.set(false);
  }

  /**
   * Vigia da carga: a casca nova subiu e nada de conteúdo no prazo (um pedaço de código velho, uma rede travada).
   * Atualiza de novo, uma única vez; na segunda desiste e libera a tela para a pessoa ver o que houver.
   */
  private firstContentLate(win: Window): void {
    this.watchdogTimer = undefined;
    if (!this.bootRefreshing()) return;
    if (guardActive(win, UPDATE_WATCHDOG_KEY, AUTO_RECOVERY_GUARD_MS)) {
      this.bootRefreshing.set(false);
      return;
    }
    writeStamp(win, UPDATE_WATCHDOG_KEY);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.applying = true;
    this.applyingUpdate.set(true);
    let tookOver = false;
    try {
      tookOver = await this.takeOverNewWorker();
    } catch {
      // Qualquer tropeço aqui ainda termina na recarga abaixo: o toque nunca vira um beco sem saída.
    }
    await this.clearRuntimeCaches();
    // Último recurso: o worker novo não assumiu. Recarregar sob o worker antigo só devolve a casca antiga (ele a serve do
    // próprio precache) e o aviso voltaria; então o registro é desfeito para a recarga vir da rede e a página nova
    // registrar o worker de novo.
    if (!tookOver) await this.dropStaleWorker();
    this.reload();
  }

  /**
   * Faz o worker novo assumir a página. Com um worker esperando, pede a troca e espera o `controllerchange`; sem nenhum,
   * pede uma busca e espera a instalação. Cada espera tem prazo: se o worker não responde, devolve `false`. Um worker que
   * vira `redundant` no meio do pedido (outro deploy chegou e o substituiu) não é sucesso: o ciclo recomeça uma vez com o
   * que estiver esperando. Devolve `true` só quando a página passou a ser controlada pelo worker novo ou quando não há
   * nada mais novo para ativar.
   */
  private async takeOverNewWorker(): Promise<boolean> {
    const win = this.win;
    const registration = this.registration;
    if (!win || !registration) return true;
    const container = win.navigator.serviceWorker;
    const controllerBefore = container.controller;
    for (let attempt = 0; attempt < 2; attempt++) {
      const waiting =
        registration.waiting ??
        (await this.withTimeout(this.findNewWorker(registration), UPDATE_INSTALL_TIMEOUT_MS));
      // Sem nada instalado e nada instalando: não há versão mais nova. Instalando ainda, passado o prazo: não deu tempo.
      if (!waiting) return !registration.installing;
      // Os ouvintes entram antes da mensagem: o worker pode assumir antes de o `postMessage` voltar.
      const outcome = this.whenActivated(container, waiting);
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch {
        // O worker pode ter terminado entre a leitura e a mensagem; o prazo abaixo cobre.
      }
      const result = await this.withTimeout(outcome, UPDATE_ACTIVATE_TIMEOUT_MS);
      if (result === 'taken') return true;
      if (result === undefined) return false;
      // `redundant`: o substituto já pode ter assumido sozinho.
      if (container.controller !== controllerBefore) return true;
    }
    return false;
  }

  /** Pede a busca de uma versão nova e devolve o worker instalado, se houve um. */
  private async findNewWorker(
    registration: ServiceWorkerRegistration,
  ): Promise<ServiceWorker | undefined> {
    try {
      await registration.update();
    } catch {
      // Sem rede, sem versão nova: segue com o que houver.
    }
    if (registration.waiting) return registration.waiting;
    const installing = registration.installing;
    if (!installing) return undefined;
    return new Promise((resolve) => {
      const check = () => {
        if (installing.state === 'installed') resolve(registration.waiting ?? installing);
        else if (installing.state === 'redundant') resolve(undefined);
      };
      installing.addEventListener('statechange', check);
      check();
    });
  }

  /**
   * Resolve `taken` quando o worker passou a controlar a página (ou, o que dá no mesmo, terminou de ativar) e `redundant`
   * quando ele foi descartado antes disso (um worker mais novo o substituiu).
   */
  private whenActivated(
    container: ServiceWorkerContainer,
    worker: ServiceWorker,
  ): Promise<'taken' | 'redundant'> {
    return new Promise((resolve) => {
      const done = (outcome: 'taken' | 'redundant') => {
        container.removeEventListener('controllerchange', onControl);
        worker.removeEventListener('statechange', onState);
        resolve(outcome);
      };
      const onControl = () => done('taken');
      const onState = () => {
        if (worker.state === 'activated') done('taken');
        else if (worker.state === 'redundant') done('redundant');
      };
      container.addEventListener('controllerchange', onControl);
      worker.addEventListener('statechange', onState);
      onState();
    });
  }

  /** Resolve com o valor da promessa ou, passado o prazo, com `undefined` (a espera nunca trava a atualização). */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    const win = this.win;
    if (!win) return promise;
    return new Promise((resolve) => {
      const timer = win.setTimeout(() => resolve(undefined), ms);
      promise.then(
        (value) => {
          win.clearTimeout(timer);
          resolve(value);
        },
        () => {
          win.clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }

  /**
   * Apaga os caches de execução que podem guardar conteúdo velho. O precache (a casca nova, que o worker que acabou de
   * assumir acabou de montar) e a arte dos exercícios ficam, para o uso offline não se perder.
   */
  private async clearRuntimeCaches(): Promise<void> {
    await this.deleteCaches((name) => !isProtectedCache(name));
  }

  /** Apaga os caches que o filtro aceita, com prazo: a limpeza nunca segura a recarga e nunca lança. */
  private async deleteCaches(matches: (name: string) => boolean): Promise<void> {
    const storage = this.win?.caches;
    if (!storage) return;
    const clear = async () => {
      const names = await storage.keys();
      await Promise.all(names.filter(matches).map((name) => storage.delete(name)));
    };
    await this.withTimeout(clear(), UPDATE_CACHE_CLEAR_TIMEOUT_MS);
  }

  /**
   * Desfaz o worker que não largou a página, mas só com a rede de pé: sem rede o app precisa do worker (e do precache)
   * para abrir, então ali a recarga segue sob o worker antigo. A sonda usa `/health/`, que o worker não intercepta, para
   * saber se a rede responde de verdade. Só desregistrar não basta: o registro continua valendo para esta página até ela
   * fechar e a recarga ainda seria servida do precache antigo; sem o precache o worker busca a página na rede, e a
   * página nova registra o worker de novo (que remonta o precache).
   */
  private async dropStaleWorker(): Promise<void> {
    const win = this.win;
    const registration = this.registration;
    if (!win || !registration || typeof win.fetch !== 'function') return;
    try {
      const reachable = await this.withTimeout(
        win
          .fetch('/health/version', { cache: 'no-store', credentials: 'same-origin' })
          .then((response) => response.ok)
          .catch(() => false),
        UPDATE_CACHE_CLEAR_TIMEOUT_MS,
      );
      if (!reachable) return;
      await this.withTimeout(registration.unregister(), UPDATE_CACHE_CLEAR_TIMEOUT_MS);
      await this.deleteCaches((name) => name.startsWith('workbox-precache'));
    } catch {
      // Sem desfazer o worker a recarga ainda acontece.
    }
  }

  private async register(win: Window): Promise<void> {
    if (this.registering || this.registration) return;
    this.registering = true;
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await registerServiceWorker(win, this.enabled);
    } catch {
      // A rede pode estar indisponível na abertura; os eventos de conexão tentam novamente sem afetar a tela.
      return;
    } finally {
      this.registering = false;
    }
    if (!registration) return;
    this.registration = registration;
    const container = win.navigator.serviceWorker;

    // Sem controlador ainda é a primeira instalação: não há "versão nova" para oferecer.
    const checkWaiting = () => {
      if (registration.waiting && container.controller) this.updateReady.set(true);
    };
    const watchInstalling = () => {
      const incoming = registration.installing;
      if (!incoming || this.watchedWorkers.has(incoming)) return;
      this.watchedWorkers.add(incoming);
      const checkInstalled = () => {
        if (incoming.state === 'installed' && container.controller) this.updateReady.set(true);
      };
      incoming.addEventListener('statechange', checkInstalled);
      // The installing worker can finish before updatefound listeners are attached.
      checkInstalled();
    };
    registration.addEventListener('updatefound', watchInstalling);
    // register() may resolve after updatefound, so inspect both states already in progress.
    watchInstalling();
    checkWaiting();
    // Pede armazenamento durável para o navegador não limpar a casca e os dados locais por falta de uso.
    void win.navigator.storage?.persist?.().catch(() => undefined);
  }

  /** Registra quando ainda não há worker; depois disso, pede uma atualização no máximo uma vez por minuto. */
  private checkForUpdate(win: Window): void {
    if (!this.registration) {
      void this.register(win);
      return;
    }
    const now = Date.now();
    if (this.lastUpdateCheckAt !== null && now - this.lastUpdateCheckAt < UPDATE_CHECK_THROTTLE_MS)
      return;
    this.lastUpdateCheckAt = now;
    void this.registration.update().catch(() => undefined);
  }

  /**
   * Um único caminho de recarregamento. A marca no `sessionStorage` faz a página nova nascer já com o esqueleto, para o
   * fundo vazio nunca aparecer entre o fim da casca velha e o primeiro conteúdo da nova.
   */
  private reload(): void {
    if (this.reloading) return;
    this.reloading = true;
    const win = this.win;
    try {
      const location = win?.location;
      if (!win || !location) throw new Error('Janela indisponível para recarregar.');
      writeStamp(win, UPDATE_REFRESHING_KEY);
      if (this.resumeUrl) location.assign(this.resumeUrl);
      else location.reload();
    } catch {
      // Só mostra erro se o recarregamento em si falhou; senão o toque sempre termina numa página nova.
      if (this.win) removeKey(this.win, UPDATE_REFRESHING_KEY);
      this.reloading = false;
      this.applying = false;
      this.applyingUpdate.set(false);
      this.updateError.set(true);
    }
  }
}
