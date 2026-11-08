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
import { OTHER_TABS_ANSWER_TIMEOUT_MS, answerTabBusyQueries, askOtherTabs } from './tab-busy';
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
/**
 * Depois do `beforeunload`, uma falha de pedaço de código ainda pode ser só a navegação abortando a importação: a
 * recuperação espera este prazo pelo `pagehide` antes de valer (a saída pode ter sido desistida).
 */
export const LEAVING_GRACE_MS = 5000;
/** O toque espera, no máximo, este tempo as escritas em voo terminarem antes de recarregar (sem perguntar à pessoa). */
export const UPDATE_WRITES_WAIT_MS = 5_000;
const WRITES_POLL_MS = 100;

/** Por que o diálogo do toque abre: trabalho não salvo nesta aba, ou em outra aba aberta. */
export type UpdateConfirmation = 'mine' | 'other-tab';

/** Chaves do `sessionStorage` (por aba): a marca de atualização em curso e as guardas contra laço. */
export const UPDATE_REFRESHING_KEY = 'uniover.update.refreshing';
export const UPDATE_WATCHDOG_KEY = 'uniover.update.watchdog';
export const CHUNK_RECOVERY_KEY = 'uniover.update.chunk-recovery';
export const CONTROLLER_CHANGE_KEY = 'uniover.update.controller-change';
/** Bloqueio compartilhado que cada aba segura enquanto vive: é como se sabe se há outra aba aberta. */
export const TAB_LOCK_NAME = 'uniover.tab';

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
 * Um worker novo só ativa pelo toque no aviso (com confirmação se esta aba tem trabalho não salvo) ou na próxima abertura a
 * frio. Os caminhos automáticos (pedaço ausente, primeira pintura atrasada, outra aba que trocou o worker) só recarregam esta
 * página com a tela limpa (`UnsavedWork`); havendo trabalho, adiam e deixam o aviso à vista até um momento seguro. Eles nunca
 * ativam um worker que espera, e o último recurso (desfazer registro e precache) só roda com uma única aba aberta.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly enabled = inject(PWA_ENABLED);
  private readonly unsaved = inject(UnsavedWork);
  private readonly destroyRef = inject(DestroyRef);
  private registration: ServiceWorkerRegistration | undefined;
  private started = false;
  private registering = false;
  private applying = false;
  private reloading = false;
  private lastUpdateCheckAt: number | null = null;
  private watchdogTimer: number | undefined;
  /** Recarga automática adiada por trabalho não salvo (`undefined`: nada adiado); a guarda de laço só é gravada quando ela acontece. */
  private deferred: { key: string; escalate: boolean } | undefined;
  /** O aviso de versão nova foi aceso só por um adiamento (nenhum worker novo o pediu). */
  private noticeFromDeferral = false;
  /** Já há uma espera pelo fim das escritas para tentar a recarga adiada de novo. */
  private waitingForWrites = false;
  /** Conferindo se há outra aba antes do último recurso. */
  private checking = false;
  /** Decidindo o que fazer com o toque (esperando escritas, perguntando às outras abas). */
  private deciding = false;
  /** A página já tinha um worker no comando (a primeira instalação, que assume a página, não é troca). */
  private controlled = false;
  private visibilityBound = false;
  /** A página já saiu de cena (`pagehide`): a pessoa está indo para outro endereço, então nenhuma recuperação a segura aqui. */
  private leaving = false;
  /**
   * Quando a saída começou (`beforeunload`, que pode ser desistida). Enquanto não vier `pagehide` nem `pageshow`, toda
   * falha de pedaço passa pela confirmação da casca velha; nos primeiros `LEAVING_GRACE_MS` ela ainda espera pelo `pagehide`.
   */
  private leavingSince: number | null = null;
  /**
   * A confirmação em andamento (uma só, compartilhada pelas falhas da mesma saída; a rota da última vale). Fica de pé
   * até o `pagehide`, o `pageshow` ou uma navegação concluída a derrubarem; quem a perdeu não age mais.
   */
  private grace: { target: string | undefined; timer: number | undefined } | undefined;
  /** Os scripts de módulo que estavam no HTML ao abrir: a casca. Os que entram depois não dizem nada sobre ela. */
  private readonly bootScripts: readonly string[];
  private readonly router = inject(Router);
  /** Para onde a recarga vai quando a recuperação nasceu de uma navegação que falhou (senão, recarrega onde está). */
  private resumeUrl: string | undefined;
  private readonly watchedWorkers = new WeakSet<ServiceWorker>();
  private readonly bootRefreshing = signal(false);

  readonly updateReady = signal(false);
  readonly applyingUpdate = signal(false);
  readonly updateError = signal(false);
  /** O toque no aviso com trabalho não salvo (nesta aba ou noutra) abre a confirmação antes de recarregar. */
  readonly confirmingUpdate = signal<UpdateConfirmation | null>(null);
  /**
   * Uma navegação falhou (pedaço de código que a versão nova levou) enquanto a recarga está adiada por trabalho não salvo:
   * o aviso passa a dizer o motivo ("salve para continuar") em vez de a navegação simplesmente não acontecer.
   */
  readonly navigationBlocked = signal(false);
  /** O toque está decidindo (esperando escritas, perguntando às outras abas): o botão mostra "Atualizando…" sem o esqueleto. */
  readonly updateDeciding = signal(false);
  /**
   * O esqueleto de página inteira fica de pé do toque em "Atualizar" até o primeiro conteúdo da página nova (a recarga
   * recomeça o app, então a marca atravessa a recarga pelo `sessionStorage`).
   */
  readonly showSkeleton = computed(() => this.applyingUpdate() || this.bootRefreshing());

  constructor() {
    const win = this.win;
    if (!win) {
      this.bootScripts = [];
      return;
    }
    this.bootScripts = Array.from(
      win.document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
    ).map((script) => script.src);
    const navigations = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.onNavigated();
    });
    this.destroyRef.onDestroy(() => navigations.unsubscribe());
    this.watchLeaving(win);
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

  /**
   * Quando a pessoa sai da página (endereço novo, recarga), o navegador aborta os pedaços de código ainda em voo e eles
   * falham com a mesma mensagem de um arquivo que sumiu, antes mesmo do `pagehide` (o `beforeunload` vem primeiro). Isso
   * não é casca velha: recuperar nesse momento mandaria a página de volta ao endereço de antes e atropelaria a navegação
   * da pessoa. Se a página volta do cache de voltar/avançar (`persisted`), ela está viva de novo.
   */
  private watchLeaving(win: Window): void {
    const starting = () => (this.leavingSince = Date.now());
    const left = () => {
      this.leaving = true;
      this.cancelGrace();
    };
    const back = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      this.leaving = false;
      this.leavingSince = null;
      this.cancelGrace();
    };
    win.addEventListener('beforeunload', starting);
    win.addEventListener('pagehide', left);
    win.addEventListener('pageshow', back);
    this.destroyRef.onDestroy(() => {
      win.removeEventListener('beforeunload', starting);
      win.removeEventListener('pagehide', left);
      win.removeEventListener('pageshow', back);
      this.cancelGrace();
    });
  }

  private cancelGrace(): void {
    if (this.grace?.timer !== undefined) this.win?.clearTimeout(this.grace.timer);
    this.grace = undefined;
  }

  /**
   * Uma falha de pedaço com uma saída só começada (`beforeunload`): nos primeiros `LEAVING_GRACE_MS` espera o `pagehide`;
   * passado o prazo (ou se ele já passou), só recupera depois de confirmar com a rede que a casca está mesmo velha, para
   * uma saída lenta nunca ser atropelada. Várias falhas reaproveitam a mesma confirmação.
   */
  private confirmBeforeRecovering(win: Window, target: string | undefined): void {
    if (this.grace) {
      this.grace.target = target;
      return;
    }
    const grace = { target, timer: undefined as number | undefined };
    this.grace = grace;
    const run = () => {
      grace.timer = undefined;
      if (this.grace !== grace) return;
      const left = this.leavingGraceLeft();
      if (left > 0) {
        grace.timer = win.setTimeout(run, left);
        return;
      }
      void this.shellIsStale(win).then((stale) => {
        if (stale && this.grace === grace && !this.leaving) {
          this.grace = undefined;
          this.recoverNow(grace.target);
        } else if (this.grace === grace) {
          this.grace = undefined;
        }
      });
    };
    run();
  }

  /**
   * Confirma, com a rede, que a casca aberta é velha: algum script de módulo do HTML original (o nome dele carrega o hash
   * de todo o resto) já não existe no servidor. Barato (um HEAD por script, com prazo curto); sem resposta (sem rede,
   * prazo, erro do servidor, método recusado) não há confirmação e a página não recarrega: nunca por palpite.
   */
  private async shellIsStale(win: Window): Promise<boolean> {
    if (typeof win.fetch !== 'function' || this.bootScripts.length === 0) return false;
    const gone = async (src: string): Promise<boolean> => {
      try {
        const response = await win.fetch(src, { method: 'HEAD', cache: 'no-store' });
        if (response.status === 404 || response.status === 410) return true;
        // Servidor que devolve a página para qualquer endereço: um script que vira HTML também sumiu.
        return response.ok && (response.headers.get('content-type') ?? '').startsWith('text/html');
      } catch {
        return false;
      }
    };
    const verdict = await this.withTimeout(
      Promise.all(this.bootScripts.map(gone)).then((all) => all.some(Boolean)),
      UPDATE_CACHE_CLEAR_TIMEOUT_MS,
    );
    return verdict === true;
  }

  /** Chamado na inicialização do app; não bloqueia a primeira tela. */
  start(): void {
    const win = this.win;
    if (this.started || !win || !this.enabled) return;
    this.started = true;
    this.holdTabLock(win);
    // As outras abas perguntam, antes de um toque delas, se esta tem trabalho não salvo.
    this.destroyRef.onDestroy(answerTabBusyQueries(win, () => this.unsaved.needsConfirmation()));
    const container = win.navigator.serviceWorker;
    this.controlled = container?.controller != null;
    // Permanente: um worker novo pode assumir esta aba por pedido de outra.
    container?.addEventListener('controllerchange', () => this.onControllerChange(win));
    const run = () => this.checkForUpdate(win);
    if (win.document.readyState === 'complete') run();
    else win.addEventListener('load', run, { once: true });
    // Uma primeira tentativa offline não impede a próxima: a conexão e a volta à aba são novas oportunidades.
    win.addEventListener('online', run);
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') run();
    });
  }

  /**
   * O toque no aviso. Antes de ativar o worker novo (que muda TODAS as abas e tira o precache antigo):
   * - texto digitado ou editor sujo nesta aba: pede confirmação (`mine`);
   * - escritas em voo: espera até `UPDATE_WRITES_WAIT_MS` terminarem, sem perguntar, e confere de novo se a espera trouxe texto
   *   não salvo de volta (um salvamento que falhou);
   * - outra aba com trabalho não salvo (pergunta por `BroadcastChannel`, ~500 ms; quem não responde conta como limpa): pede
   *   confirmação (`other-tab`);
   * - o treino aberto não pede nada: a sessão fica gravada no aparelho.
   * Sem nada disso, atualiza direto. Durante a decisão o botão fica em "Atualizando…" (`updateDeciding`), sem o esqueleto de
   * página inteira e sem piscar. Devolve a promessa da decisão (a troca em si não é esperada).
   */
  applyUpdate(): Promise<void> {
    if (this.applying || this.deciding) return Promise.resolve();
    return this.decideTap();
  }

  private async decideTap(): Promise<void> {
    const win = this.win;
    this.deciding = true;
    this.updateDeciding.set(true);
    this.updateError.set(false);
    let ask: UpdateConfirmation | null = null;
    try {
      if (this.unsaved.needsConfirmation()) {
        ask = 'mine';
      } else {
        if (this.unsaved.isWriting()) {
          await this.waitForWrites(win);
          if (this.unsaved.needsConfirmation()) ask = 'mine';
        }
        // Uma aba só (pelo bloqueio compartilhado) dispensa a pergunta e os 500 ms dela.
        if (
          !ask &&
          win &&
          (await this.otherTabsMayBeOpen()) &&
          (await askOtherTabs(win, OTHER_TABS_ANSWER_TIMEOUT_MS))
        ) {
          ask = 'other-tab';
        }
        // A página segue usável durante a decisão: confere de novo logo antes de trocar.
        if (!ask && this.unsaved.needsConfirmation()) ask = 'mine';
      }
    } finally {
      this.deciding = false;
    }
    if (ask) {
      this.updateDeciding.set(false);
      this.confirmingUpdate.set(ask);
      return;
    }
    this.proceed();
  }

  /** Espera as escritas em voo acabarem (confere a cada 100 ms), no máximo `UPDATE_WRITES_WAIT_MS`. */
  private async waitForWrites(win: Window | null): Promise<void> {
    if (!win) return;
    const until = Date.now() + UPDATE_WRITES_WAIT_MS;
    while (this.unsaved.isWriting() && Date.now() < until) {
      await new Promise<void>((resolve) => win.setTimeout(resolve, WRITES_POLL_MS));
    }
  }

  /**
   * A pessoa confirmou o diálogo. Aceitou perder o texto digitado, não um pedido que ainda está saindo: espera as escritas em
   * voo terminarem (no máximo `UPDATE_WRITES_WAIT_MS`) antes de trocar a casca. Devolve a promessa dessa espera.
   */
  async confirmUpdate(): Promise<void> {
    if (this.applying || this.deciding) return;
    // O que estava sujo quando a pessoa aceitou: ela aceitou perder isso, não o que ficar sujo durante a espera.
    const acceptedDirty = new Set(this.unsaved.dirtySources());
    this.confirmingUpdate.set(null);
    this.deciding = true;
    this.updateDeciding.set(true);
    try {
      await this.waitForWrites(this.win);
    } finally {
      this.deciding = false;
    }
    // Se durante a espera algo novo ficou sujo (um editor que não estava sujo quando a pessoa aceitou), pergunta de novo.
    if (this.unsaved.dirtySources().some((source) => !acceptedDirty.has(source))) {
      this.updateDeciding.set(false);
      this.confirmingUpdate.set('mine');
      return;
    }
    this.proceed();
  }

  /** Decidido: troca a casca de verdade e sempre termina recarregando a página. */
  private proceed(): void {
    this.confirmingUpdate.set(null);
    this.updateError.set(false);
    this.cancelDeferral();
    // `refreshByTap` liga `applyingUpdate` na hora, então não há intervalo em que o botão volte a "Atualizar".
    void this.refreshByTap();
    this.updateDeciding.set(false);
  }

  /** A pessoa preferiu continuar o que estava fazendo. */
  cancelUpdate(): void {
    this.confirmingUpdate.set(null);
  }

  /**
   * A navegação terminou com sucesso: a pessoa seguiu em frente, então um alvo guardado de uma navegação que tinha falhado
   * já não vale; é também um momento seguro. Com uma recarga adiada, ela dispara se a tela estiver limpa.
   */
  onNavigated(): void {
    this.cancelGrace();
    this.resumeUrl = undefined;
    this.navigationBlocked.set(false);
    void this.runDeferred();
  }

  /**
   * Uma rota ou importação falhou porque o pedaço de código não existe mais (a casca aberta é de uma versão que o
   * servidor já trocou). Recarrega a página, no máximo uma vez por janela (a guarda no `sessionStorage` impede laço), mas só
   * com a tela limpa: nunca por cima de trabalho não salvo (adia e deixa o aviso à vista). Não ativa worker, não desfaz
   * registro e não apaga cache: com o worker antigo ainda no comando, o precache antigo serve os pedaços antigos. `target` é a
   * rota que o usuário tentava abrir: o roteador volta ao endereço anterior quando a navegação falha, então a recarga vai
   * direto ao alvo em vez de largá-lo na tela de antes. Com a página saindo (`pagehide`), não faz nada (a falha é só a
   * importação abortada pela navegação). Com a saída só começada (`beforeunload`, sem `pagehide` nem `pageshow` depois),
   * espera `LEAVING_GRACE_MS` pelo `pagehide` e, em qualquer caso, só recarrega se a casca estiver confirmadamente velha (uma
   * confirmação só, desfeita por `pagehide`, `pageshow` e navegação concluída). Devolve `true` se há uma recuperação em
   * curso (ou começou agora) e `false` se a guarda a negou, para o erro seguir o caminho normal.
   */
  recoverFromStaleShell(target?: string): boolean {
    if (this.applying || this.checking || this.reloading) return true;
    const win = this.win;
    if (!win) return false;
    // A página está saindo: o pedaço que falhou foi abortado pela navegação da pessoa, não perdido pelo deploy.
    if (this.leaving) return true;
    if (this.leavingSince !== null) {
      this.confirmBeforeRecovering(win, target);
      return true;
    }
    return this.recoverNow(target);
  }

  /** A recuperação em si, já sem dúvida de que a página fica: guarda de laço, trabalho não salvo e recarga. */
  private recoverNow(target: string | undefined): boolean {
    if (this.applying || this.checking || this.reloading) return true;
    const win = this.win;
    if (!win) return false;
    if (this.deferred === undefined && guardActive(win, CHUNK_RECOVERY_KEY, AUTO_RECOVERY_GUARD_MS))
      return false;
    // Só caminhos do próprio app: nada de `//host` nem de esquema.
    if (target && target.startsWith('/') && !target.startsWith('//')) this.resumeUrl = target;
    if (this.deferred !== undefined) {
      // Outra tentativa de navegar, vinda da pessoa: é um momento seguro para conferir. Se ainda assim há trabalho, a
      // navegação não vai acontecer e o aviso diz por quê.
      void this.runDeferred().then(() => {
        if (this.deferred !== undefined) this.explainBlockedNavigation();
      });
      return true;
    }
    void this.reloadAutomatically(CHUNK_RECOVERY_KEY, false).then((started) => {
      if (!started) this.explainBlockedNavigation();
    });
    return true;
  }

  /** Quanto falta dos primeiros `LEAVING_GRACE_MS` de uma saída começada (`beforeunload`), em que o `pagehide` ainda é esperado. */
  private leavingGraceLeft(): number {
    if (this.leavingSince === null) return 0;
    return Math.max(0, this.leavingSince + LEAVING_GRACE_MS - Date.now());
  }

  /** A primeira página real da casca nova apareceu: o esqueleto pode sair e o vigia da carga é desarmado. */
  markContentReady(): void {
    // O vigia adiou (outra aba aberta, trabalho não salvo) e o conteúdo apareceu mesmo assim: não há mais o que recuperar. O
    // adiamento cai, e o aviso cai com ele se foi só ele que o acendeu.
    if (this.deferred?.key === UPDATE_WATCHDOG_KEY) {
      this.deferred = undefined;
      this.navigationBlocked.set(false);
      if (this.noticeFromDeferral) this.updateReady.set(false);
      this.noticeFromDeferral = false;
    }
    if (!this.bootRefreshing()) return;
    if (this.watchdogTimer !== undefined) this.win?.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.bootRefreshing.set(false);
  }

  /**
   * Vigia da carga: a casca nova subiu e nada de conteúdo no prazo (um pedaço de código velho, uma rede travada).
   * Tenta de novo, uma única vez, escalando para o último recurso (desfazer o worker velho); na segunda desiste e libera a
   * tela para a pessoa ver o que houver.
   */
  private firstContentLate(win: Window): void {
    this.watchdogTimer = undefined;
    if (!this.bootRefreshing()) return;
    if (guardActive(win, UPDATE_WATCHDOG_KEY, AUTO_RECOVERY_GUARD_MS)) {
      this.bootRefreshing.set(false);
      return;
    }
    void this.reloadAutomatically(UPDATE_WATCHDOG_KEY, true).then((started) => {
      // Adiada: a tela volta para a pessoa enquanto espera um momento seguro.
      if (!started) this.bootRefreshing.set(false);
    });
  }

  /**
   * Um worker novo assumiu a página sem que esta aba o tivesse pedido (a pessoa tocou no aviso em outra aba, ou outra aba
   * abriu a frio): a casca desta aba é velha e o precache antigo já saiu, então o próximo pedaço de código vai falhar.
   * Recarrega já se a tela está limpa; senão deixa o aviso à vista e recarrega no próximo momento seguro. A primeira
   * instalação (sem controlador antes) não é troca.
   */
  private onControllerChange(win: Window): void {
    const wasControlled = this.controlled;
    this.controlled = win.navigator.serviceWorker.controller !== null;
    if (!wasControlled || this.applying || this.reloading) return;
    if (guardActive(win, CONTROLLER_CHANGE_KEY, AUTO_RECOVERY_GUARD_MS)) {
      // Dois deploys seguidos: não recarrega de novo dentro da janela, mas a aba está com a casca velha, então avisa.
      this.raiseForNewWorker();
      return;
    }
    void this.reloadAutomatically(CONTROLLER_CHANGE_KEY, false);
  }

  /**
   * Recarga automática (sem toque). Só com a tela limpa: trabalho não salvo adia, e a guarda de laço (`key`) só é gravada
   * quando a recarga acontece. Nunca ativa um worker que espera (isso é do toque ou da próxima abertura a frio). O modo
   * `escalate` é o último recurso (desfazer o registro e apagar o precache, para a página vir da rede): só com esta aba limpa
   * e nenhuma outra aba aberta, porque desfazer o precache quebra os pedaços das outras. Devolve `true` se a recarga começou.
   */
  private async reloadAutomatically(key: string, escalate: boolean): Promise<boolean> {
    const win = this.win;
    if (!win) return false;
    if (this.unsaved.hasUnsaved()) {
      this.deferReload(win, key, escalate);
      return false;
    }
    if (!escalate) {
      writeStamp(win, key);
      this.reload();
      return true;
    }
    this.checking = true;
    const others = await this.otherTabsMayBeOpen().finally(() => (this.checking = false));
    if (others || this.unsaved.hasUnsaved()) {
      this.deferReload(win, key, escalate);
      return false;
    }
    writeStamp(win, key);
    // Agora é de verdade: o esqueleto só entra daqui em diante.
    this.applying = true;
    this.applyingUpdate.set(true);
    await this.clearRuntimeCaches();
    await this.dropStaleWorker();
    this.reload();
    return true;
  }

  /**
   * Deixa o aviso de versão nova à vista e guarda de onde veio a recarga (a guarda de laço `key` e se é o último recurso).
   * A recarga adiada não tem relógio: confere nos momentos seguros (navegação concluída, nova tentativa de navegar, volta à
   * aba), nunca no meio de uma digitação. Nada disso liga o esqueleto.
   */
  private deferReload(win: Window, key: string, escalate: boolean): void {
    // Se o aviso só aparece por causa deste adiamento, ele sai junto com o adiamento.
    if (!this.updateReady()) this.noticeFromDeferral = true;
    this.updateReady.set(true);
    if (this.deferred !== undefined) {
      this.deferred = { key, escalate: this.deferred.escalate || escalate };
      return;
    }
    this.deferred = { key, escalate };
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') void this.runDeferred();
    });
  }

  /** Num momento seguro: se a tela está limpa, faz a recarga que estava adiada. */
  private async runDeferred(): Promise<void> {
    const deferred = this.deferred;
    if (!deferred || this.applying || this.checking || this.reloading) return;
    if (this.unsaved.hasUnsaved()) return;
    this.deferred = undefined;
    await this.reloadAutomatically(deferred.key, deferred.escalate);
  }

  /** Um worker novo (ou uma troca de worker) acendeu o aviso: ele não depende mais de nenhum adiamento. */
  private raiseForNewWorker(): void {
    this.noticeFromDeferral = false;
    this.updateReady.set(true);
  }

  /**
   * Depois de uma navegação que falhou com a recarga adiada: se a tela tem algo a salvar ou descartar, o aviso diz por quê. Se
   * só há uma escrita em voo, não há nada a salvar: a recarga é tentada de novo quando ela terminar.
   */
  private explainBlockedNavigation(): void {
    if (this.unsaved.needsConfirmation()) {
      this.navigationBlocked.set(true);
      return;
    }
    if (!this.unsaved.hasUnsaved() || this.waitingForWrites) return;
    this.waitingForWrites = true;
    this.unsaved.afterWrites(() => {
      this.waitingForWrites = false;
      void this.runDeferred();
    });
  }

  private cancelDeferral(): void {
    this.deferred = undefined;
  }

  /**
   * Procura outra aba do app aberta, pelo bloqueio compartilhado que cada aba segura enquanto vive (`start`). Sem Web Locks,
   * ou sem resposta, não dá para garantir que não há outra: conta como "pode haver".
   */
  private async otherTabsMayBeOpen(): Promise<boolean> {
    const locks = this.win?.navigator.locks;
    if (!locks || typeof locks.query !== 'function') return true;
    try {
      const snapshot = await this.withTimeout(locks.query(), UPDATE_CACHE_CLEAR_TIMEOUT_MS);
      if (!snapshot) return true;
      return (snapshot.held ?? []).filter((lock) => lock.name === TAB_LOCK_NAME).length > 1;
    } catch {
      return true;
    }
  }

  /** Cada aba segura este bloqueio compartilhado pelo tempo em que vive: é o jeito de contar as abas abertas. */
  private holdTabLock(win: Window): void {
    const locks = win.navigator.locks;
    if (!locks || typeof locks.request !== 'function') return;
    let release: (() => void) | undefined;
    const acquire = () =>
      locks
        .request(
          TAB_LOCK_NAME,
          { mode: 'shared' },
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .catch(() => undefined);
    void acquire();
    // Uma página que segura um bloqueio pode ficar de fora do cache de voltar/avançar: larga ao sair e pega de novo se voltar.
    win.addEventListener('pagehide', () => {
      release?.();
      release = undefined;
    });
    win.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted && release === undefined) void acquire();
    });
  }

  /**
   * O toque confirmado: faz o worker novo assumir a página, limpa os caches de execução e recarrega (último recurso: se o
   * worker não assumiu, desfaz o registro para a recarga vir da rede). É a única via que ativa um worker que espera.
   */
  private async refreshByTap(): Promise<void> {
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
    // Desfazer o registro e o precache quebra os pedaços das outras abas: só com uma aba aberta (ver `otherTabsMayBeOpen`).
    if (!tookOver && !(await this.otherTabsMayBeOpen())) await this.dropStaleWorker();
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
      // Sem nenhum worker mais novo (esperando, instalando ou achado agora) não há o que desfazer: o worker atual é o certo e
      // o precache dele é o que abre o app sem rede.
      if (!(await this.newerWorkerExists(registration))) return;
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

  /** Há um worker esperando ou instalando, ou uma busca nova (`update()`) acabou de achar um. */
  private async newerWorkerExists(registration: ServiceWorkerRegistration): Promise<boolean> {
    if (registration.waiting || registration.installing) return true;
    await this.withTimeout(
      registration.update().catch(() => undefined),
      UPDATE_CACHE_CLEAR_TIMEOUT_MS,
    );
    return Boolean(registration.waiting || registration.installing);
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
      if (registration.waiting && container.controller) this.raiseForNewWorker();
    };
    const watchInstalling = () => {
      const incoming = registration.installing;
      if (!incoming || this.watchedWorkers.has(incoming)) return;
      this.watchedWorkers.add(incoming);
      const checkInstalled = () => {
        if (incoming.state === 'installed' && container.controller) this.raiseForNewWorker();
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
