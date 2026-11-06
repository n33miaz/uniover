import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  isDevMode,
  signal,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { registerServiceWorker } from './register-sw';
import { UnsavedWork } from './unsaved-work';

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
/** Quanto se espera o worker perguntar às abas e responder se a troca automática pode seguir; sem resposta, não troca. */
export const UPDATE_SWAP_ASK_TIMEOUT_MS = 4_000;
/** A troca na navegação ociosa tem a mesma guarda contra laço das outras recuperações automáticas. */
export const IDLE_SWAP_GUARD_MS = 60_000;

/** Chaves do `sessionStorage` (por aba): a marca de atualização em curso e as guardas contra laço. */
export const UPDATE_REFRESHING_KEY = 'uniover.update.refreshing';
export const UPDATE_WATCHDOG_KEY = 'uniover.update.watchdog';
export const CHUNK_RECOVERY_KEY = 'uniover.update.chunk-recovery';
export const IDLE_SWAP_KEY = 'uniover.update.idle-swap';

/** Resultado do pedido de troca do worker (ver `PwaUpdateService.takeOverNewWorker`). */
type TakeOver = 'taken' | 'none' | 'busy' | 'sent-failed' | 'unsettled';

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
 *
 * A troca (ativar o worker novo e recarregar) só acontece num momento seguro: quando a pessoa toca no aviso, na próxima
 * abertura a frio (o worker novo espera até lá), ou numa navegação ociosa. Os caminhos automáticos conferem o
 * `UnsavedWork` (formulário sujo, fila de saída, escrita em voo, treino aberto): havendo algo, adiam e mostram o aviso
 * discreto, e a conferência se repete até a tela ficar limpa, logo antes de ativar e de novo logo antes de recarregar.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly enabled = inject(PWA_ENABLED);
  private readonly unsaved = inject(UnsavedWork);
  private registration: ServiceWorkerRegistration | undefined;
  private started = false;
  private registering = false;
  private applying = false;
  private reloading = false;
  private lastUpdateCheckAt: number | null = null;
  private watchdogTimer: number | undefined;
  /** Chave de guarda de laço da origem da recarga adiada (`undefined`: nada adiado); só é gravada quando a recarga acontece. */
  private deferredKey: string | undefined;
  private visibilityBound = false;
  private readonly router = inject(Router);
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
    const navigations = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.onNavigated();
    });
    inject(DestroyRef).onDestroy(() => navigations.unsubscribe());
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
    this.answerBusyQueries(win);
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
    this.cancelDeferral();
    void this.refresh(false);
  }

  /**
   * A navegação terminou com sucesso: a pessoa seguiu em frente, então um alvo guardado de uma navegação que tinha falhado
   * já não vale; é também um momento seguro. Com uma recarga adiada, ela dispara se a tela estiver limpa; senão, com versão
   * nova esperando, tenta a troca ociosa.
   */
  onNavigated(): void {
    this.resumeUrl = undefined;
    this.unsaved.prune();
    if (this.deferredKey !== undefined) this.runDeferred();
    else this.applyOnIdleNavigation();
  }

  /**
   * Com versão nova esperando e a tela ociosa (nada digitado, fila vazia, nenhuma escrita em voo, e, perguntando ao worker,
   * nenhuma outra aba com trabalho) é o melhor momento para trocar sem a pessoa notar. No máximo uma vez por janela;
   * ocupado, não faz nada (o aviso continua e a próxima navegação tenta de novo).
   */
  applyOnIdleNavigation(): void {
    const win = this.win;
    if (!win || this.applying || !this.updateReady() || this.unsaved.hasUnsaved()) return;
    if (guardActive(win, IDLE_SWAP_KEY, IDLE_SWAP_GUARD_MS)) return;
    writeStamp(win, IDLE_SWAP_KEY);
    this.cancelDeferral();
    void this.refresh(true, IDLE_SWAP_KEY);
  }

  /**
   * Uma rota ou importação falhou porque o pedaço de código não existe mais (a casca aberta é de uma versão que o
   * servidor já trocou). Atualiza pelo mesmo caminho do botão, no máximo uma vez por janela (a guarda no
   * `sessionStorage` impede laço). `target` é a rota que o usuário tentava abrir: o roteador volta ao endereço anterior
   * quando a navegação falha, então a recarga vai direto ao alvo em vez de largá-lo na tela de antes. Com trabalho não
   * salvo (nesta aba ou em outra) a recarga é adiada e o aviso fica à vista. Devolve `true` se há uma recuperação em curso (ou
   * começou agora) e `false` se a guarda a negou, para o erro seguir o caminho normal.
   */
  recoverFromStaleShell(target?: string): boolean {
    if (this.applying) return true;
    const win = this.win;
    if (!win) return false;
    if (
      this.deferredKey === undefined &&
      guardActive(win, CHUNK_RECOVERY_KEY, AUTO_RECOVERY_GUARD_MS)
    )
      return false;
    // Só caminhos do próprio app: nada de `//host` nem de esquema.
    if (target && target.startsWith('/') && !target.startsWith('//')) this.resumeUrl = target;
    if (this.deferredKey !== undefined) {
      // Outra tentativa de navegar, vinda da pessoa: é um momento seguro para conferir.
      this.runDeferred();
      return true;
    }
    if (this.unsaved.hasUnsaved()) {
      this.deferReload(win, CHUNK_RECOVERY_KEY);
      return true;
    }
    writeStamp(win, CHUNK_RECOVERY_KEY);
    void this.refresh(true, CHUNK_RECOVERY_KEY);
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
    if (this.unsaved.hasUnsaved()) {
      this.bootRefreshing.set(false);
      this.deferReload(win, UPDATE_WATCHDOG_KEY);
      return;
    }
    writeStamp(win, UPDATE_WATCHDOG_KEY);
    void this.refresh(true, UPDATE_WATCHDOG_KEY);
  }

  /**
   * Deixa o aviso de versão nova à vista e guarda a chave de guarda de laço (`key`) da origem da recarga, que só é gravada
   * quando ela acontece. A recarga adiada não tem relógio: confere nos momentos seguros (navegação concluída, nova tentativa
   * de navegar, volta à aba), nunca no meio de uma digitação.
   */
  private deferReload(win: Window, key: string): void {
    this.updateReady.set(true);
    if (this.deferredKey !== undefined) return;
    this.deferredKey = key;
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') this.runDeferred();
    });
  }

  /** Num momento seguro: se a tela já está limpa, faz a recarga que estava adiada. */
  private runDeferred(): void {
    const win = this.win;
    const key = this.deferredKey;
    if (!win || key === undefined || this.applying || this.unsaved.hasUnsaved()) return;
    this.deferredKey = undefined;
    writeStamp(win, key);
    void this.refresh(true, key);
  }

  private cancelDeferral(): void {
    this.deferredKey = undefined;
  }

  /** Apareceu trabalho não salvo (nesta aba ou noutra) antes de qualquer passo sem volta: larga a recarga e espera. */
  private resumeAfterWork(key: string): void {
    this.applying = false;
    this.applyingUpdate.set(false);
    if (this.win) this.deferReload(this.win, key);
  }

  /**
   * `automatic`: o caminho não nasceu de um toque. Só desiste da recarga enquanto nada irreversível aconteceu:
   * antes de pedir a troca do worker (a troca só vem se TODAS as abas estiverem limpas, ver `askSwap`) e antes de desfazer
   * o registro. Passou desse ponto, a recarga sempre acontece: uma casca velha sob um worker novo, ou sem worker, é pior que
   * recarregar.
   */
  private async refresh(automatic: boolean, key = CHUNK_RECOVERY_KEY): Promise<void> {
    if (automatic && this.unsaved.hasUnsaved()) {
      this.resumeAfterWork(key);
      return;
    }
    this.applying = true;
    this.applyingUpdate.set(true);
    let outcome: TakeOver = 'unsettled';
    try {
      outcome = await this.takeOverNewWorker(automatic);
    } catch {
      // Qualquer tropeço aqui ainda termina na recarga abaixo: o toque nunca vira um beco sem saída.
    }
    if (outcome === 'busy') {
      this.resumeAfterWork(key);
      return;
    }
    const committed = outcome === 'taken' || outcome === 'sent-failed';
    if (automatic && !committed && this.unsaved.hasUnsaved()) {
      this.resumeAfterWork(key);
      return;
    }
    await this.clearRuntimeCaches();
    // Último recurso: o worker novo não assumiu. Recarregar sob o worker antigo só devolve a casca antiga (ele a serve do
    // próprio precache) e o aviso voltaria; então o registro é desfeito para a recarga vir da rede e a página nova
    // registrar o worker de novo.
    if (outcome === 'sent-failed' || outcome === 'unsettled') await this.dropStaleWorker();
    this.reload();
  }

  /**
   * Faz o worker novo assumir a página. Com um worker esperando, pede a troca e espera o `controllerchange`; sem nenhum,
   * pede uma busca e espera a instalação. Cada espera tem prazo. Um worker que vira `redundant` no meio do pedido (outro
   * deploy chegou e o substituiu) não é sucesso: o ciclo recomeça uma vez com o que estiver esperando.
   * Resultados: `taken` (a página passou a ser controlada pelo worker novo), `none` (não há nada mais novo),
   * `busy` (modo automático: o worker recusou a troca porque alguma aba tem trabalho; nada mudou), `sent-failed` (a troca
   * foi pedida e o worker não assumiu no prazo) e `unsettled` (nada foi pedido: o worker nem terminou de instalar).
   */
  private async takeOverNewWorker(automatic: boolean): Promise<TakeOver> {
    const win = this.win;
    const registration = this.registration;
    if (!win || !registration) return 'none';
    const container = win.navigator.serviceWorker;
    const controllerBefore = container.controller;
    for (let attempt = 0; attempt < 2; attempt++) {
      const waiting =
        registration.waiting ??
        (await this.withTimeout(this.findNewWorker(registration), UPDATE_INSTALL_TIMEOUT_MS));
      // Sem nada instalado e nada instalando: não há versão mais nova. Instalando ainda, passado o prazo: não deu tempo.
      if (!waiting) return registration.installing ? 'unsettled' : 'none';
      // Os ouvintes entram antes da mensagem: o worker pode assumir antes de a resposta voltar.
      const activation = this.whenActivated(container, waiting);
      if (automatic) {
        const verdict = await this.askSwap(win, waiting);
        if (verdict !== 'swapped') {
          activation.dispose();
          return 'busy';
        }
      } else {
        try {
          waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch {
          // O worker pode ter terminado entre a leitura e a mensagem; o prazo abaixo cobre.
        }
      }
      const result = await this.withTimeout(activation.promise, UPDATE_ACTIVATE_TIMEOUT_MS);
      activation.dispose();
      if (result === 'taken') return 'taken';
      if (result === undefined) return 'sent-failed';
      // `redundant`: o substituto já pode ter assumido sozinho.
      if (container.controller !== controllerBefore) return 'taken';
    }
    return 'sent-failed';
  }

  /**
   * Pede ao worker que espera a troca, mas só se NENHUMA aba tiver trabalho não salvo: o `skipWaiting` com `clientsClaim` muda
   * o worker de todas as abas e apaga o precache antigo, então uma aba ociosa não pode decidir pelas outras. O worker conhece as
   * abas (`clients.matchAll`), pergunta a cada uma (ver `answerBusyQueries`) e trata a que não responde como ocupada; só então
   * chama `skipWaiting` e responde `swapped`. Sem resposta no prazo, sem `MessageChannel` ou com erro, vale `busy`.
   */
  private async askSwap(win: Window, worker: ServiceWorker): Promise<'swapped' | 'busy'> {
    const Channel = (win as Window & typeof globalThis).MessageChannel as
      typeof MessageChannel | undefined;
    if (typeof Channel !== 'function') return 'busy';
    const channel = new Channel();
    const answer = new Promise<'swapped' | 'busy'>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent) =>
        resolve(event.data === 'swapped' ? 'swapped' : 'busy');
    });
    try {
      worker.postMessage({ type: 'SWAP_IF_SAFE' }, [channel.port2]);
    } catch {
      channel.port1.close();
      return 'busy';
    }
    const verdict = await this.withTimeout(answer, UPDATE_SWAP_ASK_TIMEOUT_MS);
    channel.port1.close();
    return verdict ?? 'busy';
  }

  /**
   * Responde ao worker quando ele pergunta, antes de uma troca automática, se esta aba tem trabalho não salvo. O worker precisa
   * da resposta das abas; `startMessages` garante a entrega mesmo a uma aba que ainda não tem controlador.
   */
  private answerBusyQueries(win: Window): void {
    const container = win.navigator.serviceWorker;
    if (!container) return;
    container.addEventListener('message', (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== 'ARE_YOU_BUSY') return;
      event.ports[0]?.postMessage({ busy: this.unsaved.hasUnsaved() });
    });
    container.startMessages?.();
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
   * quando ele foi descartado antes disso (um worker mais novo o substituiu). `dispose` tira os ouvintes se a espera for
   * abandonada.
   */
  private whenActivated(
    container: ServiceWorkerContainer,
    worker: ServiceWorker,
  ): { promise: Promise<'taken' | 'redundant'>; dispose: () => void } {
    let dispose: () => void = () => undefined;
    const promise = new Promise<'taken' | 'redundant'>((resolve) => {
      const done = (outcome: 'taken' | 'redundant') => {
        dispose();
        resolve(outcome);
      };
      const onControl = () => done('taken');
      const onState = () => {
        if (worker.state === 'activated') done('taken');
        else if (worker.state === 'redundant') done('redundant');
      };
      dispose = () => {
        container.removeEventListener('controllerchange', onControl);
        worker.removeEventListener('statechange', onState);
      };
      container.addEventListener('controllerchange', onControl);
      worker.addEventListener('statechange', onState);
      onState();
    });
    return { promise, dispose };
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
      // Sem registro, `checkForUpdate` registra de novo (a recarga que segue também o faz).
      this.registration = undefined;
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
      // A recarga falhou depois de o registro ter sido desfeito: sem worker o app não abre offline, então registra de novo.
      if (this.win && this.enabled && !this.registration) void this.register(this.win);
    }
  }
}
