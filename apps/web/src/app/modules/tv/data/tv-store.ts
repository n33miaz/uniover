import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { SessionState } from '../../../core/session/session-state';
import { StreamEvent, StreamService } from '../../../core/sse/stream.service';
import { TvAccess } from './tv-access';
import { TvApi, tvEventsPath } from './tv-api';
import type { TvCleanupReport, TvPowerSchedule } from './tv-api';
import { TV_CONFIG } from './tv-config';
import { describeCleanup } from './tv-cleanup';
import { TvFailure, TvFailureContext, describeFailure, forbiddenMessage } from './tv-errors';
import { ReadWatch } from './tv-read-watch';
import { withOrder } from './tv-order';
import { powerOffNotice } from './tv-power';
import { TvSelection } from './tv-selection';
import {
  TV_STREAM_EVENTS,
  TvKey,
  TvShortcut,
  TvState,
  TvSummary,
  TvWatchdog,
  clockText,
  dayClockText,
  parseShortcuts,
  parseState,
  parseWatchdog,
  shortcutLabel,
  tvCanPowerOffSafely,
} from './tv-types';

/**
 * Chip de estado do cabeçalho. `hibernating` é "controle dormindo": a TV não está desligada, só a sessão dorme. `loading`
 * é "ainda não sei" (sem leitura, reconectando, servidor acordando): a tela o mostra verde, como o controle pronto.
 * `unresponsive` é a leitura que passou do prazo sem resposta; `pc-off` é o computador do agente CONFIRMADO desligado
 * (fora da graça de presença da API, com o "desde quando" conhecido); `agent-off`, o agente fora sem esse detalhe.
 */
export type TvStatus =
  | 'unconfigured'
  | 'offline'
  | 'loading'
  | 'unresponsive'
  | 'pc-off'
  | 'agent-off'
  | 'hot'
  | 'hibernating';

export type TvLink = 'ok' | 'waking' | 'offline';
export type TvStreamStatus = 'connecting' | 'live' | 'reconnecting';

export interface TvNotice {
  readonly kind: 'error' | 'info';
  readonly text: string;
}

/** Resultado mais recente recebido nesta tela; o relatório completo permanece na API para consultas posteriores. */
export interface TvLastCleanup {
  readonly at: Date;
  readonly freedMb: number | null;
  readonly result: 'completed' | 'skipped';
  readonly reason: string | null;
}

/** Limite do texto digitado, o mesmo da API (caracteres Unicode, não unidades UTF-16). */
export const TV_TEXT_MAX = 200;

/**
 * O último estado visto da TV. Cada conta guarda o seu (`tvStateCacheKey`): a chave sem conta, de antes, não dizia de quem
 * era o estado, e a TV padrão é a mesma para todas as contas, então a conta seguinte a receberia. Hoje ela só se descarta.
 */
/** Quanto tempo o "+1 / -1" do volume sem leitura fica na pílula depois do último toque. */
const VOLUME_NUDGE_MS = 2500;
const CACHE_KEY = 'uniover.tv.last-state';
/**
 * Os ícones dos apps ficam numa chave só deles (também por conta, `tvIconsCacheKey`; a de antes só se descarta): cada um
 * pode ter ~44 mil caracteres e o estado é regravado a cada mudança de volume, então dentro do estado eles pesariam a cada
 * toque (e uma lista cheia estouraria a cota do navegador, levando junto o "visto às"). Aqui a gravação só acontece quando
 * a lista muda, e tem teto.
 */
const ICONS_KEY = 'uniover.tv.app-icons';
/** Teto, em caracteres de base64, do que se guarda de ícones: cerca de 1 MB, bem abaixo da cota de 5 MB do navegador. */
export const ICONS_CACHE_MAX_CHARS = 1_000_000;

/** Onde fica, por conta, o último estado visto da TV (o mesmo padrão das preferências e da escolha da TV). */
export function tvStateCacheKey(accountId: string): string {
  return `${CACHE_KEY}.${encodeURIComponent(accountId)}`;
}

/** Onde ficam, por conta, os ícones dos apps guardados à parte do estado. */
export function tvIconsCacheKey(accountId: string): string {
  return `${ICONS_KEY}.${encodeURIComponent(accountId)}`;
}

const STREAM_EVENTS = [
  TV_STREAM_EVENTS.state,
  TV_STREAM_EVENTS.shortcuts,
  TV_STREAM_EVENTS.watchdog,
  // O `StreamService` liga um ouvinte para cada nome pedido: "open" e "error" chegam como eventos e dão o
  // "reconectando" sem o core precisar expor o estado da conexão.
  'open',
  'error',
];

interface CachedTv {
  /** A TV de quem é o estado guardado (`null` = a padrão, também nos guardados de antes de haver várias). */
  readonly tv?: string | null;
  readonly state: TvState;
  readonly seenAt: number;
  readonly shortcuts: TvShortcut[] | null;
}

/**
 * Texto digitado válido para a API: 0 a 200 caracteres, sem quebra de linha nem outros caracteres de controle. O vazio
 * é válido: significa "apague o que o agente digitou", e é como o campo da TV esvazia quando se apaga o texto.
 */
export function isValidTvText(text: string): boolean {
  if ([...text].length > TV_TEXT_MAX) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/.test(text);
}

/**
 * Estado da tela da TV (signals). Um só para as três abas; a tela chama `start` ao nascer (abre o fluxo SSE, busca o
 * estado e os atalhos e, enquanto a página está visível, "aquece" a sessão com a TV a cada poucos minutos) e `stop`
 * ao ser destruída. Nenhum botão do controle altera o estado de forma otimista: quem muda o estado é o que o servidor
 * informa. A única exceção é a ordem dos atalhos (`reorder`): ela só mexe numa lista da tela, não na TV, e volta ao que
 * era se o servidor recusar.
 *
 * Só faz o que a conta pode (`TvAccess`): sem `module:tv` não abre o fluxo nem busca nada, sem `tv:control` não aquece a
 * sessão e cada comando confere a própria permissão antes de ir ao servidor. Assim nenhuma chamada que a API recusaria
 * (403) sai daqui, e a tela, que já esconde o que a pessoa não pode, não depende só disso.
 *
 * Com várias TVs (`TvSelection`) o estado, os atalhos e o fluxo são os da TV escolhida. Trocar de TV (`selectTv`) apaga na
 * hora o que se sabia da anterior (a tela volta a "conectando" até a nova responder), reabre o fluxo na nova e descarta
 * qualquer resposta que ainda chegue da antiga: cada chamada assíncrona confere a `epoch` do instante em que saiu.
 *
 * O mesmo vale para a conta da sessão. O store é único para o app inteiro, então sair e entrar noutra conta sem recarregar
 * a página o deixaria com o estado, os atalhos, a lista de TVs e o último estado guardado da conta anterior. Quando a conta
 * (`SessionState.accountId`) muda, o store esquece tudo, fecha o fluxo e descarta o que ainda estiver em voo; a tela só volta a
 * pedir algo ao servidor depois de a lista de TVs da conta nova chegar. O que se guarda no aparelho (último estado e ícones)
 * é de uma conta só: sem rede, nunca se mostra o que outra conta deixou.
 */
@Injectable({ providedIn: 'root' })
export class TvStore {
  private readonly api = inject(TvApi);
  private readonly stream = inject(StreamService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly config = inject(TV_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private readonly access = inject(TvAccess);
  private readonly selection = inject(TvSelection);
  private readonly session = inject(SessionState);

  private readonly _state = signal<TvState | null>(null);
  private readonly _seenAt = signal<number | null>(null);
  private readonly _shortcuts = signal<TvShortcut[] | null>(null);
  private readonly _watchdog = signal<TvWatchdog | null>(null);
  private readonly _notConfigured = signal(false);
  /** Um comando ou leitura CONFIRMOU o agente fora do ar antes de qualquer estado chegar (sem estado para marcar). */
  private readonly _agentUnavailable = signal(false);
  /** A primeira leitura do estado e a da lista de atalhos têm cada uma o seu esqueleto e o seu teto de espera. */
  private readonly stateWatch = new ReadWatch(
    () => this.config.skeletonDelayMs,
    () => this.config.readTimeoutMs,
    () => this.link() === 'waking',
  );
  private readonly shortcutsWatch = new ReadWatch(
    () => this.config.skeletonDelayMs,
    () => this.config.readTimeoutMs,
    () => this.link() === 'waking',
  );
  private readonly _streamStatus = signal<TvStreamStatus>('connecting');
  private readonly _notice = signal<TvNotice | null>(null);
  private readonly _inFlightKeys = signal(0);
  /** Conta cada comando que o controle aceitou: o ponto de estado pisca uma vez por toque. */
  private readonly _keyPulse = signal(0);
  private readonly _volumeNudge = signal(0);
  private readonly _cleaning = signal(false);
  private readonly _lastCleanup = signal<TvLastCleanup | null>(null);
  private readonly _powerSchedule = signal<TvPowerSchedule | null>(null);
  private readonly _lastPowerSchedule = signal<TvPowerSchedule | null>(null);
  private readonly _powerScheduleLoaded = signal(false);
  /** O último texto gravado em `ICONS_KEY`, para não regravar o mesmo. */
  private iconsSaved = '';
  /** A última lista que o servidor confirmou, guardada enquanto a ordem nova não é confirmada (volta para ela se for recusada). */
  private reorderBase: TvShortcut[] | null = null;
  /** A ordem mais nova pedida e ainda não enviada: toques em sequência viram um envio só, sempre com a última. */
  private reorderWanted: string[] | null = null;
  /** O envio em andamento; quem pede outra ordem durante ele se junta a ele. */
  private reorderRun: Promise<boolean> | null = null;
  /** A lista que chegou do servidor durante o envio, à espera: aplicada por cima, a tela piscaria de volta à ordem de um passo atrás. */
  private heldShortcuts: TvShortcut[] | null = null;

  /** Invalida os sinais públicos quando a referência de conta em memória muda. */
  private readonly accountEpoch = signal(0);
  /** Nada de uma conta anterior fica visível até a troca ser sincronizada, inclusive antes do próximo ciclo do Angular. */
  private readonly currentAccount = computed(() => {
    this.accountEpoch();
    return this.session.accountId() === this.account;
  });
  readonly state = computed(() => (this.currentAccount() ? this._state() : null));
  readonly shortcuts = computed(() => (this.currentAccount() ? this._shortcuts() : null));
  readonly watchdog = computed(() => (this.currentAccount() ? this._watchdog() : null));
  readonly notConfigured = computed(() => this.currentAccount() && this._notConfigured());
  /** A primeira leitura do estado passou da espera curta: só o que depende dele mostra a forma de espera. */
  readonly stateLoading = computed(
    () => this.currentAccount() && this._state() === null && this.stateWatch.skeleton(),
  );
  /** A lista de apps passou da espera curta: só os atalhos e o painel de Apps mostram a forma de espera. */
  readonly shortcutsLoading = computed(
    () => this.currentAccount() && this._shortcuts() === null && this.shortcutsWatch.skeleton(),
  );
  /** A lista de apps não veio no prazo: o painel diz isso e oferece tentar de novo (nunca o brilho em laço). */
  readonly shortcutsFailed = computed(
    () => this.currentAccount() && this._shortcuts() === null && this.shortcutsWatch.timedOut(),
  );
  /** Algo ainda é esperado por mais que a espera curta (para o texto único do leitor de tela). */
  readonly loading = computed(() => this.stateLoading() || this.shortcutsLoading());
  readonly streamStatus = computed<TvStreamStatus>(() =>
    this.currentAccount() ? this._streamStatus() : 'connecting',
  );
  readonly notice = computed(() => (this.currentAccount() ? this._notice() : null));
  readonly inFlightKeys = computed(() => (this.currentAccount() ? this._inFlightKeys() : 0));
  readonly keyPulse = this._keyPulse.asReadonly();
  /**
   * Quantos passos de volume a TV confirmou desde o último toque (mais menos menos), por poucos segundos. Só serve à
   * pílula de volume quando o agente não consegue ler o nível: é o retorno do toque, nunca um número do volume.
   */
  readonly volumeNudge = computed(() => (this.currentAccount() ? this._volumeNudge() : 0));
  /** Há uma limpeza da TV em andamento (leva alguns segundos): um pedido por vez, e o resto do controle segue. */
  readonly cleaning = computed(() => this.currentAccount() && this._cleaning());
  readonly lastCleanup = computed(() => (this.currentAccount() ? this._lastCleanup() : null));
  readonly powerSchedule = computed(() => (this.currentAccount() ? this._powerSchedule() : null));
  readonly lastPowerSchedule = computed(() =>
    this.currentAccount() ? this._lastPowerSchedule() : null,
  );

  readonly hibernateMinutes = this.config.hibernateMinutes;

  /** As TVs que a conta vê (`null` sem lista) e a que está em uso; o seletor do cabeçalho vive disto. */
  readonly tvs = this.selection.tvs;
  readonly selectedTv = this.selection.selected;
  /** O agente desta TV desliga com leitura: só aperta `POWER` com a TV lida como ligada e confirma o resultado. */
  readonly safePowerOff = computed(() => tvCanPowerOffSafely(this.selection.selected()));
  readonly canSchedulePowerOff = computed(
    () =>
      this._powerScheduleLoaded() &&
      this.access.power() &&
      this.safePowerOff() &&
      this.selection.selected()?.online === true &&
      this.link() === 'ok',
  );
  /** Há mais de uma TV: só então o título vira seletor. */
  readonly multiple = this.selection.multiple;

  /** Hora (HH:MM) em que esta tela recebeu o último estado; é o "visto às" mostrado sem rede. */
  readonly seenAtText = computed(() => (this.currentAccount() ? clockText(this._seenAt()) : null));

  /** "28/10 19:24" (horário local), desde quando o PC está desligado; `null` se o servidor não sabe. */
  readonly pcOffSince = computed<string | null>(() => {
    const since = dayClockText(this._state()?.offlineSince ?? null);
    return since === '' ? null : since;
  });

  /** "PC Desligado desde 28/10 19:24" (horário local); `null` se o servidor não sabe desde quando. */
  readonly agentOffText = computed<string | null>(() => {
    const since = dayClockText(this._state()?.offlineSince ?? null);
    return since ? $localize`:@@tv.status.pc-off-since:PC Desligado desde ${since}:since:` : null;
  });

  readonly link = computed<TvLink>(() => {
    if (!this.connectivity.online() || this.connectivity.serverState() === 'offline')
      return 'offline';
    return this.connectivity.serverState() === 'waking' ? 'waking' : 'ok';
  });

  /** O que o último estado recebido diz (`null` se nunca chegou um); vale também sem rede, como "visto às". */
  readonly lastKnownStatus = computed<TvStatus | null>(() => {
    if (!this.currentAccount()) return null;
    const state = this._state();
    if (!state) return null;
    if (!state.agentOnline || state.connection === 'disconnected') return 'agent-off';
    return state.connection === 'hibernating' ? 'hibernating' : 'hot';
  });

  /**
   * O que a tela mostra. É otimista de propósito: o que ainda não é falha CONFIRMADA conta como pronto (`loading` e a
   * sessão acordando saem verdes). Só viram outra coisa a falta de rede, a falta de agente configurado, o agente que a
   * API deu como fora (`pc-off`, com o "desde quando"; `agent-off`, sem ele) e a primeira leitura que passou do prazo
   * (`unresponsive`). O servidor acordando não prova falha nenhuma: fica verde até a resposta.
   */
  readonly status = computed<TvStatus>(() => {
    if (this.link() === 'offline') return 'offline';
    if (this.currentAccount() && this._notConfigured()) return 'unconfigured';
    if (this.link() === 'waking') return 'loading';
    if (this.pcOffConfirmed()) return 'pc-off';
    const known = this.lastKnownStatus();
    if (known === 'agent-off' || this._agentUnavailable()) return 'agent-off';
    if (known === null) {
      return this.currentAccount() && this.stateWatch.timedOut() ? 'unresponsive' : 'loading';
    }
    // Sessão dormindo é só o controle poupando a TV: o primeiro toque acorda. Pedido do dono: verde, como ligado.
    return known === 'hibernating' ? 'hot' : known;
  });

  /** O PC do agente está confirmado desligado: a API deu o agente como fora da graça e disse desde quando. */
  private readonly pcOffConfirmed = computed(() => {
    const state = this._state();
    return this.currentAccount() && state !== null && !state.agentOnline && !!state.offlineSince;
  });
  /** A tela é a do PC desligado: controles esmaecidos e o selo no centro. */
  readonly pcOff = computed(() => this.status() === 'pc-off');

  /**
   * Dá para mandar comando: há rede, há agente configurado e ele não foi dado como desligado. O servidor acordando e a
   * primeira leitura em curso NÃO bloqueiam: o toque sai e espera (a API espera o agente até 25 s).
   */
  readonly canSend = computed(
    () =>
      this.currentAccount() &&
      this.account !== null &&
      !this.listFirst() &&
      this.link() !== 'offline' &&
      !this._notConfigured() &&
      !this._agentUnavailable() &&
      this._state()?.agentOnline !== false,
  );

  /**
   * Por que os botões estão desabilitados (sem falsa promessa); `null` quando estão ativos. A leitura sem resposta é a
   * exceção: os botões seguem ativos, mas a linha de aviso oferece tentar de novo.
   */
  readonly disabledReason = computed<string | null>(() => {
    if (this.canSend()) {
      return this.status() === 'unresponsive'
        ? $localize`:@@tv.reason.unresponsive:O controle não recebeu resposta. Tente de novo.`
        : null;
    }
    if (this.link() === 'offline') {
      const seen = this.seenAtText();
      return seen
        ? $localize`:@@tv.reason.offline-seen:Sem rede: o controle precisa de internet. Estado visto às ${seen}:time:.`
        : $localize`:@@tv.reason.offline:Sem rede: o controle precisa de internet.`;
    }
    return this.currentAccount() && this._notConfigured()
      ? $localize`:@@tv.reason.not-configured:Nenhum agente foi configurado para controlar a TV.`
      : (this.agentOffText() ??
          $localize`:@@tv.reason.agent-off:O agente da TV está desligado, então os botões não funcionam agora.`);
  });

  /** "controle religado às HH:MM" quando o vigia consertou o serviço; `null` sem evento recente. */
  readonly watchdogNote = computed<string | null>(() => {
    const entry = this.watchdog();
    if (!entry) return null;
    const time = clockText(entry.at);
    if (!time) return null;
    if (entry.kind === 'repaired' || entry.kind === 'recovered') {
      return $localize`:@@tv.watchdog.repaired:controle religado às ${time}:time:`;
    }
    if (entry.kind === 'repair_failed') {
      return $localize`:@@tv.watchdog.failed:reparo do controle falhou às ${time}:time:`;
    }
    return null;
  });

  private started = false;
  /** A conta de quem são o estado, a lista de TVs e o fluxo de agora (`null` = nenhuma): é a dona das chaves do aparelho. */
  private account: string | null = this.session.accountId();
  /** Já houve uma conta aqui: a seguinte espera a lista de TVs dela antes de pedir qualquer coisa. */
  private served = this.account !== null;
  /** Entrou outra conta e a lista de TVs dela ainda não chegou: nenhuma chamada automática sai antes disso. */
  private readonly listFirst = signal(false);
  /** A lista da conta nova está a caminho (um pedido só, mesmo que `connect` seja chamado de novo). */
  private listing = false;
  /**
   * Conta as trocas de TV. Toda chamada assíncrona guarda o valor de quando saiu e, ao voltar, só aplica o resultado se
   * ele continua o mesmo: uma resposta da TV anterior nunca cai na atual.
   */
  private epoch = 0;
  /** A TV de quem são o estado e o fluxo de agora (`null` = ainda não se sabe qual a API escolheu). */
  private resolvedId: string | null = null;
  /** O fluxo está aberto e o aquecimento armado: só acontece com a tela viva E com permissão de ver a TV. */
  private connected = false;
  /** Se já se tinha o controle quando o aquecimento rodou pela última vez: ganhar o controle depois aquece na hora. */
  private hadControl = false;
  private streamSub: Subscription | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onVisibility = () => {
    if (this.visible()) {
      this.connect();
      void this.wake();
      void this.refresh();
      this.armWake();
    } else {
      this.disarmWake();
    }
  };
  private readonly onOnline = () => {
    this.connect();
    void this.refresh();
    void this.wake();
  };
  /**
   * Voltar de um congelamento (o Safari do iPhone guarda a página inteira ao sair): nem sempre dispara
   * `visibilitychange`, e o fluxo e o estado podem estar velhos. Reconecta e relê na hora, como ao voltar do segundo plano.
   */
  private readonly onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted && this.visible()) this.onVisibility();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
    // A sessão pode trazer outra lista de permissões com a tela aberta: sem `module:tv` o fluxo fecha e as buscas
    // param; com ele (de volta) reabre; ganhar `tv:control` aquece a sessão com a TV na hora, sem esperar a próxima rodada.
    effect(() => {
      const view = this.access.view();
      const control = this.access.control();
      // A conta também move o efeito: com a tela aberta, outra aba pode ter trocado de conta e esta página renovado a sessão com ela.
      this.session.accountId();
      untracked(() => {
        this.syncAccount();
        if (!this.started) return;
        if (!view) this.disconnect();
        else if (!this.connected) this.connect();
        else if (control && !this.hadControl) void this.wake();
        this.hadControl = view && control;
      });
    });
  }

  start(): void {
    if (this.started) return;
    this.syncAccount();
    this.started = true;
    this._streamStatus.set('connecting');
    this.discardLegacyCaches();
    this.resolvedId = this.selection.tvId();
    this.hydrate();
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.doc.defaultView?.addEventListener('online', this.onOnline);
    this.doc.defaultView?.addEventListener('pageshow', this.onPageShow);
    this.connect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.disconnect();
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.doc.defaultView?.removeEventListener('online', this.onOnline);
    this.doc.defaultView?.removeEventListener('pageshow', this.onPageShow);
    clearTimeout(this.noticeTimer);
    clearTimeout(this.nudgeTimer);
    // Ao sair, o erro de uma leitura sem resposta não fica para a próxima vez que a tela abrir.
    this.stateWatch.done();
    this.shortcutsWatch.done();
  }

  /**
   * Abre o fluxo, busca o estado e os atalhos e começa a aquecer. Sem permissão de ver a TV, ou sem conta, não faz nada. Se
   * entrou outra conta, antes busca a lista de TVs dela (`openAfterList`).
   */
  private connect(): void {
    if (
      this.connected ||
      this.listing ||
      !this.started ||
      !this.access.view() ||
      this.account === null
    ) {
      return;
    }
    if (this.listFirst()) {
      void this.openAfterList();
      return;
    }
    this.open();
  }

  /**
   * Com a conta nova, a primeira coisa pedida é a lista de TVs dela: só com ela se sabe qual TV abrir. Se ela não vier, não
   * abre o fluxo nem manda comandos sem alvo conhecido; a próxima volta de rede tenta a lista de novo. Uma troca de conta no
   * meio da espera descarta o resultado: a conta seguinte faz o próprio pedido.
   */
  private async openAfterList(): Promise<void> {
    this.listing = true;
    const epoch = this.epoch;
    try {
      if (this.link() === 'offline') return;
      const list = await this.fetchTvs();
      if (!this.live(epoch)) return;
      if (!list) return;
      this.selection.setTvs(list);
    } finally {
      if (epoch === this.epoch) this.listing = false;
    }
    if (!this.started) return;
    this.listFirst.set(false);
    this.resolvedId = this.selection.tvId();
    this.open();
  }

  private open(): void {
    if (this.connected || !this.started || !this.access.view()) return;
    this.connected = true;
    this._streamStatus.set('connecting');
    this.streamSub = this.stream
      .open(tvEventsPath(this.selection.tvId()), STREAM_EVENTS)
      .subscribe((event) => {
        this.onEvent(event);
      });
    this.hadControl = this.access.control();
    void this.refresh();
    void this.wake();
    this.armWake();
  }

  private disconnect(): void {
    this.connected = false;
    this.hadControl = false;
    this.streamSub?.unsubscribe();
    this.streamSub = null;
    this.disarmWake();
  }

  /** Busca de novo o estado e os atalhos (abertura da tela, volta da rede, volta de aba oculta). */
  async refresh(): Promise<void> {
    const epoch = this.begin();
    if (
      this.link() === 'offline' ||
      !this.access.view() ||
      this.account === null ||
      this.listFirst()
    ) {
      return;
    }
    // Só a PRIMEIRA leitura de cada coisa tem esqueleto e teto de espera: com dado já conhecido não há o que esconder, e a
    // leitura seguinte só o renova.
    if (this._state() === null) this.stateWatch.begin();
    if (this._shortcuts() === null) this.shortcutsWatch.begin();
    // Cada resposta é aplicada assim que chega, protegida pela `epoch` (se a TV ou a conta mudou no meio, ela é
    // descartada): uma lista de TVs ou um relatório de limpeza lentos não seguram o estado nem os atalhos que já voltaram.
    // Se a lista de TVs mostrar que a TV pedida não é a certa, a troca esquece o que já tinha chegado e busca o da certa.
    const stateDone = this.api.state().then(
      (value) => {
        if (this.live(epoch)) this.applyState(value);
      },
      (error: unknown) => {
        if (!this.live(epoch)) return;
        // Só a falha CONFIRMADA pelo servidor vira estado (agente fora, nenhum agente configurado); "reconectando", rede
        // e tempo esgotado seguem como "ainda não sei" e o teto da leitura decide.
        const failure = describeFailure(error);
        if (failure.kind === 'agent-offline' || failure.kind === 'not-configured') {
          this.absorb(failure);
        }
      },
    );
    const shortcutsDone = this.api.shortcuts().then(
      (value) => {
        if (this.live(epoch)) this.receiveShortcuts(value);
      },
      () => undefined,
    );
    const tvsDone = this.fetchTvs().then((tvs) => {
      if (!this.live(epoch) || !tvs) return;
      this.selection.setTvs(tvs);
      this.reconcile();
    });
    // Só quem pode limpar a TV lê o relatório (a API recusa os outros com 403).
    const cleanupDone = (
      this.access.cleanup() ? this.api.latestCleanup() : Promise.resolve(null)
    ).then(
      (report) => {
        if (this.live(epoch)) this.applyCleanupReport(report);
      },
      () => undefined,
    );
    // O agendamento de desligar mora no botão de energia do cabeçalho (o indicador de agendado): lê-se com o resto.
    const scheduleDone = this.refreshPowerSchedule();
    await Promise.all([stateDone, shortcutsDone, tvsDone, cleanupDone, scheduleDone]);
  }

  /**
   * Escolhe a TV que o controle usa (a escolha fica neste aparelho, por conta). Apaga na hora o que se sabia da anterior
   * e busca o da nova; escolher a que já está em uso não faz nada.
   */
  selectTv(id: string): void {
    this.syncAccount();
    if (id === this.selection.selected()?.id) return;
    this.selection.select(id);
    this.reconcile();
  }

  /**
   * Pede ao agente que aqueça a sessão com a TV. Só com a tela visível, com rede e com permissão de controlar (a API
   * recusa o pedido de quem não tem `tv:control`); falha não vira aviso.
   */
  async wake(): Promise<void> {
    const epoch = this.begin();
    if (
      !this.visible() ||
      this.link() !== 'ok' ||
      !this.access.control() ||
      this.account === null ||
      this.listFirst()
    ) {
      return;
    }
    // Com o agente fora do ar não há o que aquecer (e cada pedido recusado ocuparia a trilha de comandos): a volta
    // dele chega pelo fluxo, e a leitura periódica do estado cobre o fluxo caído.
    if (this._state()?.agentOnline === false) return;
    try {
      await this.api.wake();
      if (this.live(epoch)) this._notConfigured.set(false);
    } catch (error) {
      if (this.live(epoch)) this.absorb(describeFailure(error));
    }
  }

  /** Manda uma tecla. Devolve `true` se a TV confirmou; em falha o aviso já foi mostrado e a repetição deve parar. */
  async sendKey(key: TvKey): Promise<boolean> {
    const epoch = this.begin();
    if (!this.canSend() || !this.access.control() || this.account === null || this.listFirst()) {
      return false;
    }
    this._inFlightKeys.update((count) => count + 1);
    try {
      await this.sendCommand(() => this.api.sendKey(key));
      if (this.live(epoch) && this._notice()?.kind === 'error') this.clearNotice();
      if (this.live(epoch)) this.nudgeVolume(key);
      return true;
    } catch (error) {
      if (this.live(epoch)) this.fail(error);
      return false;
    } finally {
      // A troca de TV já zerou o contador: só a tecla da TV de agora o desconta.
      if (this.live(epoch)) this._inFlightKeys.update((count) => count - 1);
    }
  }

  /**
   * Põe `text` no campo que estiver aberto na TV (o agente trata cada envio como "o campo passa a ser este texto";
   * vazio apaga tudo o que ele digitou). Sem aviso flutuante, nem de sucesso nem de falha: a aba Teclado manda a
   * cada mudança do campo e mostra o resultado dentro da própria tela. Devolve `null` se a TV confirmou, ou a falha
   * (que também atualiza o que se sabe do agente, como `agent-offline`).
   */
  async sendText(text: string): Promise<TvFailure | null> {
    const epoch = this.begin();
    if (!this.access.text()) return forbidden();
    if (!this.canSend() || this.account === null || this.listFirst()) {
      return {
        kind: 'agent-offline',
        message: this.disabledReason() ?? '',
        retryAfterSeconds: null,
      };
    }
    if (!isValidTvText(text)) {
      return {
        kind: 'invalid',
        message: $localize`:@@tv.keyboard.invalid:Escreva até 200 caracteres, sem quebra de linha.`,
        retryAfterSeconds: null,
      };
    }
    try {
      await this.sendCommand(() => this.api.sendText(text));
      return null;
    } catch (error) {
      const failure = describeFailure(error);
      if (this.live(epoch)) this.absorb(failure);
      return failure;
    }
  }

  /**
   * Desliga a TV com um único pedido (sem passkey: decisão do dono). Devolve a falha, se houver, para a folha
   * mostrar dentro dela. Depois disso a tela não promete que a TV volta: o estado vem do servidor.
   *
   * Com agente que declara o desligamento com leitura o pedido é explícito ("desligar", nunca a tecla às cegas): o
   * agente só aperta `POWER` com a TV lida como ligada, e o aviso diz o que de fato aconteceu. Com agente antigo, ou sem
   * saber o que o agente faz, segue o pedido de antes.
   */
  async powerOff(): Promise<TvFailure | null> {
    const epoch = this.begin();
    if (!this.access.power()) return forbidden();
    if (!this.canSend() || this.account === null || this.listFirst()) {
      return {
        kind: 'agent-offline',
        message: this.disabledReason() ?? '',
        retryAfterSeconds: null,
      };
    }
    const safe = this.safePowerOff();
    try {
      const outcome = await this.sendCommand(() => this.api.powerOff(safe));
      if (this.live(epoch)) this.showNotice('info', powerOffNotice(outcome));
      return null;
    } catch (error) {
      const failure = describeFailure(error, safe ? 'power-off' : undefined);
      if (this.live(epoch)) this.absorb(failure);
      return failure;
    }
  }

  async refreshPowerSchedule(): Promise<void> {
    const epoch = this.begin();
    if (!this.access.power() || this.account === null || this.link() !== 'ok') return;
    try {
      const response = await this.api.powerSchedule();
      if (this.live(epoch)) {
        this._powerSchedule.set(response.active);
        this._lastPowerSchedule.set(response.last);
        this._powerScheduleLoaded.set(true);
      }
    } catch {
      // A folha ainda permite desligar agora; a próxima abertura tenta ler de novo.
    }
  }

  async savePowerSchedule(dueAtUtc: string, timeZone: string): Promise<TvFailure | null> {
    const epoch = this.begin();
    if (!this.access.power()) return forbidden();
    if (!this.canSchedulePowerOff() || this.account === null)
      return {
        kind: 'agent-offline',
        message: this.disabledReason() ?? '',
        retryAfterSeconds: null,
      };
    try {
      const saved = await this.sendCommand(() =>
        this.api.savePowerSchedule(dueAtUtc, timeZone, this._powerSchedule()?.version ?? null),
      );
      if (this.live(epoch)) this._powerSchedule.set(saved);
      return null;
    } catch (error) {
      return describeFailure(error);
    }
  }

  async cancelPowerSchedule(): Promise<TvFailure | null> {
    const epoch = this.begin();
    if (!this.access.power()) return forbidden();
    const active = this._powerSchedule();
    if (!active) return null;
    try {
      await this.sendCommand(() => this.api.cancelPowerSchedule(active.version));
      if (this.live(epoch)) this._powerSchedule.set(null);
      return null;
    } catch (error) {
      return describeFailure(error);
    }
  }

  /**
   * Abre o app na TV. Vale para qualquer app instalado, esteja ele fixado no controle ou não: `enabled` só decide quem
   * aparece na fileira de atalhos. Um app que saiu da TV não tem o que abrir (a API também o recusa).
   */
  async launch(shortcut: TvShortcut): Promise<boolean> {
    const epoch = this.begin();
    if (
      !this.canSend() ||
      !shortcut.installed ||
      !this.access.launch() ||
      this.account === null ||
      this.listFirst()
    ) {
      return false;
    }
    try {
      await this.sendCommand(() => this.api.launch(shortcut.id));
      if (this.live(epoch)) {
        const name = shortcutLabel(shortcut);
        this.showNotice('info', $localize`:@@tv.apps.launched:${name}:name: aberto na TV.`);
      }
      return true;
    } catch (error) {
      if (this.live(epoch)) this.fail(error);
      return false;
    }
  }

  /**
   * Limpa a TV (alivia a memória e, com o interruptor da TV ligado, fecha apps em segundo plano), sem derrubar a conexão
   * do controle. Um pedido por vez (um segundo toque enquanto roda não faz nada). Devolve `true` se a TV fez; o aviso com
   * o que foi feito, ou o erro, já foi mostrado. Não trava o resto do controle: só `cleaning` muda enquanto espera.
   */
  async cleanup(): Promise<boolean> {
    const epoch = this.begin();
    if (
      !this.canSend() ||
      this._cleaning() ||
      !this.access.cleanup() ||
      this.account === null ||
      this.listFirst()
    ) {
      return false;
    }
    this._cleaning.set(true);
    try {
      const result = await this.sendCommand(() => this.api.cleanup());
      if (this.live(epoch)) {
        this._lastCleanup.set({
          at: new Date(),
          freedMb: typeof result.freedMb === 'number' ? result.freedMb : null,
          result: 'completed',
          reason: null,
        });
        this.showNotice('info', describeCleanup(result));
      }
      return true;
    } catch (error) {
      if (this.live(epoch)) this.fail(error, 'cleanup');
      return false;
    } finally {
      // A limpeza da TV anterior já foi desligada na troca; a flag agora pode ser de uma limpeza da atual.
      if (this.live(epoch)) this._cleaning.set(false);
    }
  }

  async refreshShortcuts(): Promise<boolean> {
    const epoch = this.begin();
    if (!this.canSend() || !this.access.launch() || this.account === null || this.listFirst()) {
      return false;
    }
    try {
      await this.api.refreshShortcuts();
      // A lista nova chega pelo fluxo; buscar de novo cobre o caso de o fluxo estar reconectando.
      const list = await this.api.shortcuts();
      if (!this.live(epoch)) return true;
      this.receiveShortcuts(list);
      this.showNotice('info', $localize`:@@tv.apps.refreshed:Lista de apps atualizada.`);
      return true;
    } catch (error) {
      if (this.live(epoch)) this.fail(error);
      return false;
    }
  }

  /** Dá um nome próprio ao atalho; texto vazio volta ao nome da TV (ou a "Atalho n"). Não mexe na TV, então vale sem agente. */
  async renameShortcut(id: string, label: string): Promise<boolean> {
    return this.updateShortcut(id, { customLabel: label });
  }

  async setShortcutEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.updateShortcut(id, { enabled });
  }

  /**
   * Muda a ordem dos atalhos (só com `tv:edit-shortcuts`: sem ela nada é feito, e a API também recusa). `ids` é a lista COMPLETA, na ordem desejada. A tela
   * muda na hora e o servidor confirma depois; se ele recusar, a lista volta à última ordem que ele confirmou e um aviso
   * diz que não foi salvo. Toques em sequência não disparam um pedido por toque: enquanto um envio está em curso o
   * seguinte espera, e só a ordem mais nova é enviada. Devolve `true` se o servidor aceitou. Não mexe na TV, então vale
   * sem agente.
   */
  async reorder(ids: readonly string[]): Promise<boolean> {
    this.begin();
    if (!this.access.editShortcuts()) return false;
    if (this.link() !== 'ok' || this.account === null || this.listFirst()) {
      this.showNotice('error', this.blockedText());
      return false;
    }
    const current = this._shortcuts();
    const next = current ? withOrder(current, ids) : null;
    if (!current || !next) return false;

    this.reorderBase ??= current;
    this.reorderWanted = [...ids];
    this.applyShortcuts(next);
    this.reorderRun ??= this.runReorder();
    return this.reorderRun;
  }

  clearNotice(): void {
    clearTimeout(this.noticeTimer);
    this._notice.set(null);
  }

  private async updateShortcut(
    id: string,
    change: { customLabel?: string; enabled?: boolean },
  ): Promise<boolean> {
    const epoch = this.begin();
    if (!this.access.editShortcuts()) return false;
    if (this.link() !== 'ok' || this.account === null || this.listFirst()) {
      this.showNotice('error', this.blockedText());
      return false;
    }
    try {
      const updated = await this.api.updateShortcut(id, change);
      if (!this.live(epoch)) return true;
      this._shortcuts.update(
        (list) => list?.map((item) => (item.id === id ? updated : item)) ?? list,
      );
      return true;
    } catch (error) {
      if (this.live(epoch)) this.fail(error);
      return false;
    }
  }

  private async runReorder(): Promise<boolean> {
    const epoch = this.begin();
    try {
      while (this.reorderWanted) {
        const ids = this.reorderWanted;
        this.reorderWanted = null;
        const confirmedNow = await this.api.reorderShortcuts(ids);
        // Trocou de TV no meio do envio: a ordem confirmada é a da outra, e o estado de ordem já foi zerado na troca.
        if (!this.live(epoch)) return false;
        this.reorderBase = confirmedNow;
      }
      // Tudo confirmado: vale a lista que o servidor devolveu (renumerada por ele). Nada se espera entre aqui e o fim,
      // então nenhum pedido novo entra no meio.
      const confirmed = this.reorderBase;
      const held = this.heldShortcuts;
      this.reorderBase = null;
      this.heldShortcuts = null;
      if (confirmed) this.applyShortcuts(confirmed);
      // O que chegou do servidor durante o envio só importa se não é o que acabou de ser confirmado (outra mudança, do
      // agente ou do próprio dono, se cruzou com o envio): nesse caso a lista certa se busca de novo.
      if (confirmed && held && !sameShortcuts(held, confirmed)) void this.resyncShortcuts();
      return true;
    } catch (error) {
      if (!this.live(epoch)) return false;
      const base = this.reorderBase;
      this.reorderBase = null;
      this.reorderWanted = null;
      this.heldShortcuts = null;
      if (base) this.applyShortcuts(base);
      this.reportReorderFailure(error);
      void this.resyncShortcuts();
      return false;
    } finally {
      // Depois da troca `reorderRun` já é de outra rodada (ou de nenhuma): só a rodada da TV de agora o limpa.
      if (this.live(epoch)) this.reorderRun = null;
    }
  }

  /** Falha de rede, de sessão ou de limite diz a causa; qualquer outra diz só o que importa aqui: não foi salvo. */
  private reportReorderFailure(error: unknown): void {
    const failure = describeFailure(error);
    const known =
      failure.kind === 'network' || failure.kind === 'session' || failure.kind === 'rate-limited';
    this.showNotice(
      'error',
      known
        ? failure.message
        : $localize`:@@tv.apps.reorder-failed:Não foi possível salvar a nova ordem. Ela voltou ao que era.`,
    );
  }

  private async resyncShortcuts(): Promise<void> {
    const epoch = this.begin();
    if (this.link() !== 'ok' || this.account === null || this.listFirst()) return;
    try {
      const list = await this.api.shortcuts();
      if (this.live(epoch)) this.receiveShortcuts(list);
    } catch {
      // sem rede agora: o fluxo ou a próxima busca trazem a lista certa
    }
  }

  /** Lista de atalhos vinda do servidor (fluxo ou busca): durante o envio de uma ordem ela espera a vez. */
  private receiveShortcuts(list: TvShortcut[]): void {
    this.shortcutsWatch.done();
    if (this.reorderRun) {
      this.heldShortcuts = list;
      return;
    }
    this.applyShortcuts(list);
  }

  private onEvent(event: StreamEvent): void {
    // Um evento do fluxo da conta anterior que ainda chegue depois da troca é dela, não da atual.
    if (this.syncAccount()) return;
    switch (event.type) {
      case 'open':
        this._streamStatus.set('live');
        return;
      case 'error':
        this._streamStatus.set('reconnecting');
        return;
      case TV_STREAM_EVENTS.state: {
        const state = parseState(parse(event.data));
        if (state) this.applyState(state);
        this._streamStatus.set('live');
        return;
      }
      case TV_STREAM_EVENTS.shortcuts: {
        const list = parseShortcuts(parse(event.data));
        if (list) this.receiveShortcuts(list);
        return;
      }
      case TV_STREAM_EVENTS.watchdog: {
        const entry = parseWatchdog(parse(event.data));
        if (entry) this._watchdog.set(entry);
        return;
      }
    }
  }

  private applyState(state: TvState): void {
    this.stateWatch.done();
    if (state.agentOnline) this._agentUnavailable.set(false);
    // O agente voltou: o que a TV oferece (as capacidades) só chega depois do `hello` dele, então a lista se renova.
    const previous = this._state();
    if (previous && !previous.agentOnline && state.agentOnline) void this.refreshTvs();
    this._state.set(state);
    this._seenAt.set(Date.now());
    if (state.agentOnline) this._notConfigured.set(false);
    this.persist();
  }

  private applyCleanupReport(report: TvCleanupReport | null): void {
    if (!report || (report.result !== 'completed' && report.result !== 'skipped')) return;
    const at = new Date(report.startedAt);
    if (Number.isNaN(at.getTime())) return;
    this._lastCleanup.set({
      at,
      freedMb: report.freedMb,
      result: report.result,
      reason: report.reason,
    });
  }

  private applyShortcuts(list: TvShortcut[]): void {
    this._shortcuts.set(list);
    this.persist();
    this.persistIcons(list);
  }

  /** A lista de TVs, ou `null` se ela não veio (rota ausente em servidor antigo, sem permissão, sem rede): é só "não sei". */
  private async fetchTvs(): Promise<TvSummary[] | null> {
    try {
      return await this.api.tvs();
    } catch {
      return null;
    }
  }

  /** Renova a lista de TVs (os pontos de estado e o que cada uma oferece); o seletor chama ao abrir. */
  async refreshTvs(): Promise<void> {
    const epoch = this.begin();
    if (
      this.link() === 'offline' ||
      !this.access.view() ||
      this.account === null ||
      this.listFirst()
    ) {
      return;
    }
    const list = await this.fetchTvs();
    if (list && this.live(epoch)) {
      this.selection.setTvs(list);
      this.reconcile();
    }
  }

  /**
   * Põe o que o controle mostra de acordo com a escolha. Sem TV resolvida ainda (o fluxo abriu sem `tvId`), a API
   * escolheu a primeira da lista, que é a que a escolha também aponta: só se adota, sem reabrir nada. Já com TV resolvida,
   * uma escolha diferente (a pessoa trocou, ou a guardada sumiu) troca de TV.
   */
  private reconcile(): void {
    const target = this.selection.selected()?.id ?? null;
    if (target === null) return;
    if (this.resolvedId === null) {
      this.resolvedId = target;
      return;
    }
    if (target !== this.resolvedId) this.switchTo(target);
  }

  /** Esquece tudo o que era da TV anterior e passa a falar com a nova (fluxo reaberto, estado e atalhos buscados de novo). */
  private switchTo(target: string): void {
    this.resolvedId = target;
    this.forget();
    if (!this.connected) return;
    this.disconnect();
    this._streamStatus.set('connecting');
    this.connect();
  }

  /**
   * Esquece o que se sabia (estado, atalhos, avisos, ordem em andamento) e passa a descartar o que ainda estiver em voo: a
   * `epoch` muda, e cada chamada confere a do instante em que saiu. Serve tanto à troca de TV quanto à de conta.
   */
  private forget(): void {
    this.epoch++;
    this._state.set(null);
    this._seenAt.set(null);
    this._shortcuts.set(null);
    this._watchdog.set(null);
    this._notConfigured.set(false);
    this._agentUnavailable.set(false);
    this.stateWatch.stop();
    this.stateWatch.timedOut.set(false);
    this.shortcutsWatch.stop();
    this.shortcutsWatch.timedOut.set(false);
    this._cleaning.set(false);
    this._lastCleanup.set(null);
    this._powerSchedule.set(null);
    this._lastPowerSchedule.set(null);
    this._powerScheduleLoaded.set(false);
    this._inFlightKeys.set(0);
    this._volumeNudge.set(0);
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    this.reorderBase = null;
    this.reorderWanted = null;
    this.reorderRun = null;
    this.heldShortcuts = null;
    this.clearNotice();
  }

  /**
   * A conta da sessão ainda é a do que o store guarda? Se mudou (outra pessoa entrou na mesma página, ou outra aba trocou
   * de conta), esquece tudo da anterior na hora: fecha o fluxo, descarta o que estava em voo, zera a lista de TVs (feita no
   * `TvSelection`) e, com a tela aberta e uma conta nova, pede primeiro a lista de TVs dela. Devolve se mudou.
   *
   * É síncrono de propósito: toda resposta atrasada confere a conta antes de ser aplicada (`live`), então não depende de um
   * efeito já ter rodado. O que vai para o aparelho usa `account` (a dona do que está na memória), nunca a conta lida na hora.
   */
  private syncAccount(): boolean {
    const next = this.session.accountId();
    if (next === this.account) return false;
    if (this.account !== null) this.served = true;
    this.account = next;
    this.accountEpoch.update((value) => value + 1);
    this.forget();
    this.resolvedId = null;
    this.iconsSaved = '';
    this.listing = false;
    // A primeira conta de uma página que nasce já identificada não espera: não havia nada de outra para esquecer.
    this.listFirst.set(next !== null && this.served);
    this.disconnect();
    this._streamStatus.set('connecting');
    this.discardLegacyCaches();
    if (this.started) {
      this.hydrate();
      this.connect();
    }
    return true;
  }

  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Conta o passo de volume confirmado e o apaga depois de `VOLUME_NUDGE_MS` sem novos toques. */
  private nudgeVolume(key: TvKey): void {
    if (key !== 'VOLUME_UP' && key !== 'VOLUME_DOWN') return;
    this._volumeNudge.update((steps) => steps + (key === 'VOLUME_UP' ? 1 : -1));
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this._volumeNudge.set(0), VOLUME_NUDGE_MS);
  }

  /** Todo pedido que muda ou comanda a TV passa aqui, para o retorno visual não depender do tipo de comando. */
  private async sendCommand<T>(request: () => Promise<T>): Promise<T> {
    this._keyPulse.update((count) => count + 1);
    return request();
  }

  /** Começa uma chamada: confere a conta e devolve a `epoch` com que ela vai ser conferida na volta. */
  private begin(): number {
    this.syncAccount();
    return this.epoch;
  }

  /** O resultado que voltou ainda vale: nem a TV nem a conta mudaram desde que a chamada saiu. */
  private live(epoch: number): boolean {
    this.syncAccount();
    return epoch === this.epoch;
  }

  /** As chaves sem conta, de antes, não dizem de quem é o que guardam: ninguém as lê, e a primeira partida com conta as apaga. */
  private discardLegacyCaches(): void {
    if (this.account === null) return;
    try {
      const storage = this.doc.defaultView?.localStorage;
      storage?.removeItem(CACHE_KEY);
      storage?.removeItem(ICONS_KEY);
    } catch {
      // armazenamento bloqueado: não há o que apagar nem o que vazar
    }
  }

  /** Fatos que uma falha revela sobre o agente (sem aviso): o estado verdadeiro continua vindo do servidor. */
  private absorb(failure: TvFailure): void {
    if (failure.kind === 'not-configured') this._notConfigured.set(true);
    if (failure.kind === 'agent-offline') {
      // O servidor disse "fora do ar" fora da graça de presença (dentro dela a falha é `agent-reconnecting`, que não entra
      // aqui): é certeza, mesmo sem estado lido ainda.
      this._agentUnavailable.set(true);
      this._state.update((state) =>
        state ? { ...state, agentOnline: false, connection: 'disconnected', volume: null } : state,
      );
    }
  }

  private fail(error: unknown, context?: TvFailureContext): TvFailure {
    const failure = describeFailure(error, context);
    this.absorb(failure);
    this.showNotice('error', failure.message);
    return failure;
  }

  private showNotice(kind: TvNotice['kind'], text: string): void {
    clearTimeout(this.noticeTimer);
    this._notice.set({ kind, text });
    this.noticeTimer = setTimeout(() => this._notice.set(null), this.config.noticeMs);
  }

  /** O motivo de uma ação que não sai: o dos botões apagados ou, com o servidor acordando (botões ativos), o dele. */
  private blockedText(): string {
    return (
      this.disabledReason() ??
      $localize`:@@tv.reason.waking:O servidor está acordando. Tente de novo em instantes.`
    );
  }

  private visible(): boolean {
    return this.doc.visibilityState !== 'hidden';
  }

  private armWake(): void {
    this.disarmWake();
    if (!this.started || !this.connected || !this.visible()) return;
    this.wakeTimer = setInterval(() => {
      void this.wake();
      // Rede de segurança: se o fluxo caiu sem aviso, o estado ainda se renova a cada rodada.
      void this.refresh();
    }, this.config.wakeIntervalMs);
  }

  private disarmWake(): void {
    clearInterval(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private hydrate(): void {
    // Só vale como "último estado visto" quando não há rede: com rede, o estado novo chega em instantes e um
    // estado antigo, mesmo por um segundo, contaria uma história velha.
    if (this._state() || this.link() !== 'offline' || this.account === null) return;
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(tvStateCacheKey(this.account));
      if (!raw) return;
      const cached = JSON.parse(raw) as Partial<CachedTv>;
      // O último estado guardado é de uma TV só: o de outra nunca vale como o desta.
      if ((cached.tv ?? null) !== this.selection.scope()) return;
      const state = parseState(cached.state);
      if (!state || typeof cached.seenAt !== 'number') return;
      this._state.set(state);
      this._seenAt.set(cached.seenAt);
      this._shortcuts.set(this.withCachedIcons(parseShortcuts(cached.shortcuts)));
    } catch {
      // armazenamento indisponível ou texto corrompido: começa sem estado conhecido
    }
  }

  private persist(): void {
    const state = this._state();
    const seenAt = this._seenAt();
    if (this.account === null || !state || seenAt === null) return;
    try {
      // Sem os ícones (ver `ICONS_KEY`): o estado cabe sempre, qualquer que seja o tamanho deles.
      const shortcuts = this._shortcuts()?.map((item) => ({ ...item, iconDataUri: null })) ?? null;
      const cached: CachedTv = { tv: this.selection.scope(), state, seenAt, shortcuts };
      this.doc.defaultView?.localStorage.setItem(
        tvStateCacheKey(this.account),
        JSON.stringify(cached),
      );
    } catch {
      // sem armazenamento: o estado só vive nesta tela
    }
  }

  /** Guarda os ícones da lista (os primeiros que couberem no teto); não regrava se nada mudou. */
  private persistIcons(list: TvShortcut[]): void {
    if (this.account === null) return;
    const icons: Record<string, string> = {};
    let used = 0;
    for (const item of list) {
      const uri = item.iconDataUri;
      if (typeof uri !== 'string' || used + uri.length > ICONS_CACHE_MAX_CHARS) continue;
      icons[item.id] = uri;
      used += uri.length;
    }
    // Chaves em ordem fixa: mudar a ordem dos atalhos não deve regravar (até 1 MB) o que não mudou.
    const text = JSON.stringify(
      Object.fromEntries(Object.entries(icons).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
    if (text === this.iconsSaved) return;
    try {
      this.doc.defaultView?.localStorage.setItem(tvIconsCacheKey(this.account), text);
      this.iconsSaved = text;
    } catch {
      // sem armazenamento ou sem espaço: sem ícones ao abrir sem rede (aparece a inicial), o resto segue igual
    }
  }

  /** Devolve à lista guardada os ícones guardados à parte (a tela offline mostra os mesmos azulejos). */
  private withCachedIcons(list: TvShortcut[] | null): TvShortcut[] | null {
    if (!list || this.account === null) return null;
    let icons: Record<string, unknown> = {};
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(tvIconsCacheKey(this.account));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') icons = parsed as Record<string, unknown>;
    } catch {
      // texto corrompido: segue sem ícones
    }
    return list.map((item) => {
      const icon = icons[item.id];
      return item.iconDataUri || typeof icon !== 'string' ? item : { ...item, iconDataUri: icon };
    });
  }
}

/** A conta não tem a permissão do comando (a tela não o oferece; isto cobre a troca de permissões com a tela aberta). */
function forbidden(): TvFailure {
  return { kind: 'forbidden', message: forbiddenMessage(), retryAfterSeconds: null };
}

/** As duas listas dizem o mesmo, atalho por atalho e na mesma ordem. */
function sameShortcuts(a: readonly TvShortcut[], b: readonly TvShortcut[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        item.id === other.id &&
        item.position === other.position &&
        item.enabled === other.enabled &&
        item.installed === other.installed &&
        item.customLabel === other.customLabel &&
        item.tvLabel === other.tvLabel &&
        item.iconDataUri === other.iconDataUri
      );
    })
  );
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
