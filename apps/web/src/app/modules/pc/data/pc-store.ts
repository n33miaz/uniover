import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import {
  PointerAccelerator,
  ScrollAccelerator,
  accelerationFor,
  scrollGainFor,
} from '../input/pc-acceleration';
import { PointerBatch, PointerBatcher } from '../input/pointer-batcher';
import { PcApi } from './pc-api';
import { PcDirect } from './pc-direct';
import { CANCELLED, PcFailure, pcFailureOf } from './pc-failure';
import { PcPrefs } from './pc-prefs';
import {
  PC_CLICK_V2_CAPABILITY,
  PC_KEY_V2_CAPABILITY,
  PC_TEXT_V2_CAPABILITY,
  isHoldableKey,
  keyNeedsV2,
  type PcClickButton,
  type PcClickOptions,
  type PcHoldableKey,
  type PcKey,
  type PcKeyOptions,
  type PcMediaAction,
  type PcModifier,
  type PcPowerAction,
  type PcTextEdit,
} from './pc-types';

/** De quanto em quanto tempo o estado do PC é relido enquanto a tela está aberta. */
export const PC_POLL_MS = 15_000;

/**
 * Quanto o aperto do botão (`DOWN`) espera a resposta. A API desiste em 5 s e devolve 504; passou disto sem resposta, o
 * botão pode estar apertado no PC sem a tela saber, e a saída segura é soltar já.
 */
export const DOWN_TIMEOUT_MS = 6_000;

/**
 * De quanto em quanto tempo, com o botão apertado, vai um movimento zerado. O agente solta sozinho um botão que ficou
 * apertado sem nenhum comando do PC por 30 s (a rede caiu, o aparelho travou); um arrasto longo e parado não pode contar
 * como abandono.
 */
export const HOLD_HEARTBEAT_MS = 10_000;

/**
 * Esperas entre as tentativas de soltar o botão quando soltar era o que se queria (sair da tela, esconder a página) e o
 * `UP` não passou: a primeira tentativa é imediata, e há mais uma por item daqui.
 */
export const UP_RETRY_BACKOFF_MS: readonly number[] = [300, 1_000];

/** O `UP` normal espera os movimentos em voo por até isto; passou, solta mesmo assim (botão preso é pior que um passo curto). */
export const UP_DRAIN_MS = 1_500;

/**
 * O clique e o aperto do botão esperam os movimentos que já saíram por até isto. Passou, o clique (ou o aperto) é abandonado
 * com um aviso: mandá-lo tarde cairia no alvo errado, ou viraria um clique duplo se a pessoa tocou de novo.
 */
export const MOVE_SETTLE_MS = 1_500;

/**
 * Quanto um texto ou uma tecla da fila de entrada espera a resposta. A API desiste em 5 s; passou disto sem resposta, o
 * resultado é incerto (pode ter sido digitado) e a fila segue, sem o que estava atrás dele.
 */
export const INPUT_TIMEOUT_MS = 6_000;

/** Quanto tempo o aviso de toque abandonado fica na tela, mesmo que o movimento seguinte dê certo. */
export const ABANDONED_NOTICE_MS = 4_000;

/** Um pedido do botão que desistiu porque a conta mudou: não é falha do PC e não aparece para ninguém. */
class AccountChanged extends Error {}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ignore = () => undefined;

/**
 * Espera o pedido por até `ms`: devolve `true` se o tempo acabou antes da resposta (o pedido em si segue; só a espera
 * acaba), `false` se ele terminou bem, e propaga o erro se ele falhou antes.
 */
function raceTimeout(call: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(true), ms);
    call.then(
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * - `loading`: ainda não se sabe (primeira leitura em andamento);
 * - `unavailable`: nenhum computador com o controle do PC ligado;
 * - `offline`: o computador existe, mas está desconectado agora;
 * - `ready`: pode mandar comandos.
 */
export type PcPhase = 'loading' | 'unavailable' | 'offline' | 'ready';

/**
 * O estado e os comandos do controle do PC. O estado vem da API (`PcAvailability`, o mesmo que decide o cartão da Início);
 * o movimento do dedo passa pela aceleração e pelo `PointerBatcher` (vários pedidos numerados em voo ao mesmo tempo); os demais comandos são um
 * pedido cada e devolvem a falha, quando há, para quem os chamou mostrar onde faz sentido.
 *
 * O botão esquerdo apertado (arrastar) é o único estado que fica preso no PC se a tela sumir: por isso ele é solto ao sair
 * da tela, ao esconder ou fechar a página, ao trocar de conta e quando o aperto falha ou fica sem resposta.
 */
@Injectable({ providedIn: 'root' })
export class PcStore {
  private readonly api = inject(PcApi);
  private readonly direct = inject(PcDirect);
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);
  private readonly prefs = inject(PcPrefs);
  /** A conta de quem é o estado de movimento e de arrastar guardado aqui (o store vive a aba toda, as contas não). */
  private account = this.session.accountId();
  private readonly accelerator = new PointerAccelerator();
  private readonly scroller = new ScrollAccelerator();
  private readonly batcher = new PointerBatcher((batch) => this.sendPointer(batch));
  /**
   * Os pedidos do botão (`DOWN` e `UP`) saem em fila: um `UP` só parte depois que o `DOWN` anterior terminou (resposta,
   * erro ou tempo esgotado). São pedidos HTTP independentes, e um `UP` que passasse na frente do `DOWN` o deixaria apertado.
   */
  private buttonTail: Promise<unknown> = Promise.resolve();
  /**
   * Textos e teclas saem numa fila só: o seguinte só parte depois que o anterior terminou. São pedidos HTTP independentes e
   * dois em paralelo podem se ultrapassar na API (um Enter passaria na frente do texto, uma senha digitada em dois pedaços
   * chegaria embaralhada). A tela não espera: o campo esvazia na hora, e só o início do pedido seguinte é adiado (o custo é
   * que teclas seguidas saem no ritmo de uma por ida e volta). Uma falha cancela o que já esperava atrás dela: não se
   * digita "def" depois de "abc" ter falhado.
   */
  private inputTail: Promise<unknown> = Promise.resolve();
  /** Sobe a cada falha da fila de entrada (e a cada troca de conta): o que foi pedido antes disso é cancelado. */
  private inputGeneration = 0;
  /** Cada aperto tem o seu número: um `DOWN` atrasado só pede mais um `UP` se ainda é o último. */
  private downEpoch = 0;
  /** Havia modificador segurado quando a conta trocou: o próximo `UP` pedido era dele, e não vai ao PC da conta nova. */
  private keysOfOtherAccount = false;
  /** Depois de sair da tela ou esconder a página o sinal de vida não volta (só a próxima visita o liga). */
  private heartbeatAllowed = true;
  /** Um `DOWN` foi pedido e o `UP` ainda não foi confirmado: o botão pode estar apertado no PC. */
  private maybeHeld = false;
  /** Há um `DOWN` ou um `UP` a caminho (barra o segundo toque do "Arrastar"). */
  private dragBusy = false;
  /** O `DOWN` ainda está saindo (do início da espera pelo movimento até a resposta). */
  private starting = false;
  private heartbeat: number | null = null;
  /** Pediram para soltar enquanto o `DOWN` saía: assim que ele termina, o `UP` segue. */
  private releaseWanted = false;
  /** A página foi escondida nesse meio tempo: o `UP` que segue o `DOWN` leva `keepalive`. */
  private releaseKeepalive = false;

  /** Os cliques pedidos e ainda sem resposta (o aperto do botão não passa na frente deles). */
  private readonly clicks = new Set<Promise<unknown>>();

  /** Aviso de toque abandonado ainda na tela: um movimento que dá certo não o apaga (só o tempo ou uma falha mais nova). */
  private stickyNotice: PcFailure | null = null;

  /** A última falha de um movimento (os cliques e teclas devolvem a própria falha). Some ao próximo sucesso. */
  readonly notice = signal<PcFailure | null>(null);
  /** O botão esquerdo está apertado (arrastar). */
  readonly dragging = signal(false);
  /**
   * Os modificadores que a tela segurou (`holdKey`) e ainda não soltou, ou que podem estar apertados no PC (o `DOWN` pode ter
   * chegado mesmo sem resposta). O sinal de vida e a soltura automática valem para eles como para o botão do mouse.
   */
  readonly heldKeys = signal<readonly PcHoldableKey[]>([]);

  readonly phase = computed<PcPhase>(() => {
    const status = this.availability.status();
    if (status === null) return 'loading';
    if (!status.available) return 'unavailable';
    return status.online ? 'ready' : 'offline';
  });
  readonly canSend = computed(() => this.phase() === 'ready');
  readonly apps = this.availability.apps;
  /** O que o agente do PC declarou além do básico; vazio com um agente anterior ou antes da primeira leitura. */
  readonly capabilities = this.availability.capabilities;
  /** O agente entende `pc.key.v2` (teclas novas, repetição, segurar modificador). */
  readonly supportsKeyV2 = computed(() => this.capabilities().includes(PC_KEY_V2_CAPABILITY));
  /** O agente entende `pc.text.v2` (apagar, digitar e apertar uma tecla num pedido só). */
  readonly supportsTextV2 = computed(() => this.capabilities().includes(PC_TEXT_V2_CAPABILITY));
  /** O agente entende `pc.click.v2` (clique com modificadores e com o intervalo do toque anterior). */
  readonly supportsClickV2 = computed(() => this.capabilities().includes(PC_CLICK_V2_CAPABILITY));

  constructor() {
    // Trocar de conta (sair e entrar como outra pessoa, sem recarregar) descarta o que era da anterior, mesmo sem uso.
    effect(() => {
      this.session.accountId();
      untracked(() => this.syncAccount());
    });
    // O PC caiu ou deixou de ter o controle: o agente solta o que estava apertado ao perder a conexão, e daqui já não há como
    // soltar. O estado é zerado (sem ele, o sinal de vida seguiria para um PC que não está).
    effect(() => {
      const phase = this.phase();
      if (phase === 'offline' || phase === 'unavailable') untracked(() => this.dropHeldKeys());
    });
  }

  /** Há um `DOWN` ou um `UP` a caminho: quem quer apertar o botão por outro caminho (a pressão longa) espera. */
  get buttonBusy(): boolean {
    return this.dragBusy;
  }

  /**
   * O número do último aperto do botão pedido. Quem aperta por um caminho (o dedo) o guarda para só soltar o aperto que
   * ele mesmo começou, e não um mais novo que veio de outro caminho (o botão "Arrastar").
   */
  get pressEpoch(): number {
    return this.downEpoch;
  }

  /**
   * A tela chama ao abrir: relê o estado já e depois a cada `PC_POLL_MS` (só com a aba visível). Devolve a função que
   * encerra o acompanhamento.
   */
  watch(destroy?: DestroyRef): () => void {
    void this.availability.refresh();
    this.heartbeatAllowed = true;
    // O botão continua apertado de uma visita anterior (o soltar não passou): o sinal de vida volta com a tela.
    if (this.holding()) this.startHeartbeat();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.availability.refresh();
    }, PC_POLL_MS);
    // Fechar o PWA ou ir para o segundo plano não pode deixar o botão apertado no PC (o iOS nem avisa o componente).
    const onHide = () => this.releaseOnHide(false);
    // `pagehide` com `persisted === false`: a página morre de verdade (não vai para o cache de volta e avance).
    const onPageHide = (event: Event) =>
      this.releaseOnHide((event as PageTransitionEvent).persisted === false);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void this.availability.refresh();
        // O botão continua apertado (o soltar ao esconder não passou): o sinal de vida volta.
        this.heartbeatAllowed = true;
        if (this.holding()) this.startHeartbeat();
      } else onHide();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);
    // O canal direto é um acelerador opcional: tenta abrir com a tela e, se cair, a tela solta o que o PC segurava.
    const offLost = this.direct.onLost(() => this.onDirectLost());
    this.direct.setBusyProbe(() => this.holding() || this.heldKeys().length > 0);
    this.direct.start();
    const stop = () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
      offLost();
      this.direct.setBusyProbe(null);
      // O canal fecha primeiro (o agente solta o que o PC segurava) e o `UP` que segue vai pela nuvem.
      this.direct.stop();
      this.endGesture();
      this.heartbeatAllowed = false;
      this.stopHeartbeat();
      void this.release({ persistent: true });
      void this.releaseHeldKeys({ persistent: true });
    };
    destroy?.onDestroy(stop);
    return stop;
  }

  refresh(): Promise<boolean> {
    return this.availability.refresh();
  }

  /**
   * O canal direto caiu sem a tela pedir: o agente soltou o que o PC segurava ao perdê-lo, e o resultado do que estava no
   * canal sem resposta é incerto. A tela alinha o estado soltando o botão e os modificadores (agora pela nuvem; um `UP` a
   * mais é inofensivo) e o resto segue pela nuvem sem aviso. Não precisa esperar o canal "confirmar" que fechou: o agente
   * fecha o canal em uso ANTES de executar qualquer comando de entrada que chegue pela nuvem (e solta o que ele segurava),
   * então um aperto atrasado do canal nunca cai depois destes `UP`.
   */
  private onDirectLost(): void {
    this.syncAccount();
    if (this.holding()) void this.release({ persistent: true });
    void this.releaseHeldKeys({ persistent: true });
  }

  /** Um dedo novo pousou: ele não herda a fração de pixel do anterior. */
  beginGesture(): void {
    this.syncAccount();
    this.accelerator.reset();
    this.scroller.reset();
  }

  /** O dedo saiu: manda o que ainda esperava, para o ponteiro parar onde o dedo parou. */
  endGesture(): void {
    void this.batcher.drain();
  }

  /** Passo do dedo em pixels; a sensibilidade escolhida, a aceleração e o agrupamento são daqui. */
  movePointer(dx: number, dy: number, elapsedMs: number): void {
    this.syncAccount();
    if (!this.canSend()) return;
    const step = this.accelerator.apply(
      dx,
      dy,
      elapsedMs,
      accelerationFor(this.prefs.sensitivity()),
    );
    if (step.dx !== 0 || step.dy !== 0) this.batcher.addMove(step.dx, step.dy);
  }

  /**
   * Deslize de dois dedos em pixels do centro; `elapsedMs` é o tempo desde o passo anterior (com o dedo veloz rola mais).
   * O sentido segue a escolha "inverter rolagem" e o quanto rende, a "sensibilidade da rolagem".
   */
  scrollPointer(dx: number, dy: number, elapsedMs = 16): void {
    this.syncAccount();
    if (!this.canSend()) return;
    const wheel = this.scroller.apply(
      dx,
      dy,
      elapsedMs,
      this.prefs.invertScroll(),
      scrollGainFor(this.prefs.scrollSensitivity()),
    );
    if (wheel.scrollX !== 0 || wheel.scrollY !== 0) {
      this.batcher.addScroll(wheel.scrollX, wheel.scrollY);
    }
  }

  /**
   * Clique depois de todo movimento que já saiu: espera as respostas dos pedidos de movimento feitos até agora (são pedidos
   * HTTP independentes, e um clique que os ultrapassasse cairia no lugar errado), por até `MOVE_SETTLE_MS`. Passou disso o
   * clique é abandonado com um aviso, e nunca sai tarde. A espera só custa o clique, nunca o movimento.
   */
  click(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
    options?: PcClickOptions,
  ): Promise<PcFailure | null> {
    // O aperto do botão (arrastar) espera os cliques que já saíram: um toque e, logo depois, o arrasto do toque duplo são
    // pedidos independentes, e um clique que chegasse depois do `DOWN` soltaria o botão.
    const sending = this.sendClick(button, action, options);
    this.clicks.add(sending);
    // O clique que não responde sai da lista no prazo (o do pedido de texto e tecla): um clique preso não pode barrar todo
    // aperto de botão para sempre.
    const forget = () => {
      clearTimeout(expire);
      this.clicks.delete(sending);
    };
    const expire = setTimeout(forget, INPUT_TIMEOUT_MS);
    void sending.then(forget, forget);
    return sending;
  }

  private async sendClick(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
    options?: PcClickOptions,
  ): Promise<PcFailure | null> {
    this.syncAccount();
    if (!this.canSend()) return this.blocked();
    const asked = this.account;
    // Modificador e intervalo são da `pc.click.v2`: um agente que não a declarou nem os recebe (nem pelo canal direto, que
    // recusaria a mensagem inteira); o toque sai como o de sempre.
    const extras = this.supportsClickV2() ? options : undefined;
    // O movimento feito depois do toque fica retido até o clique sair: do contrário um pedido de movimento mais novo
    // poderia ultrapassá-lo e o clique cairia no alvo novo.
    this.batcher.hold();
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      this.batcher.resume();
    };
    try {
      // Só os movimentos feitos ANTES do clique: o que o dedo andar depois não o atrasa nem muda o alvo dele.
      if (!(await this.settleMoves())) return this.abandoned();
      // A conta trocou enquanto o movimento saía: o clique era de outra pessoa e não vai ao PC desta.
      if (this.session.accountId() !== asked) return this.blocked();
      // O pedido do clique também tem prazo: sem resposta, vira `timeout` (resultado incerto) e o aviso de falha aparece.
      const sending = this.run(async () => {
        const call = extras
          ? this.api.click(button, action, extras)
          : this.api.click(button, action);
        if (await raceTimeout(call, INPUT_TIMEOUT_MS)) {
          throw new HttpErrorResponse({ status: 504 });
        }
      });
      resume(); // o pedido já saiu: o movimento retido vem atrás dele
      return await sending;
    } finally {
      resume();
    }
  }

  /** Aperta o botão esquerdo e o mantém (arrastar); chamar de novo solta. Um segundo toque com o pedido a caminho é ignorado. */
  async toggleDrag(): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.dragBusy) return null;
    return this.dragging() ? this.release() : this.startDrag();
  }

  /**
   * Aperta o botão esquerdo e o mantém até `release()`. Enquanto o aperto não termina, o movimento do dedo fica retido
   * (o ponteiro só anda com o botão já apertado). Se o aperto falhar ou ficar sem resposta, ele pode ter chegado ao PC:
   * manda o `UP` logo depois que o `DOWN` terminou (soltar nunca faz mal).
   */
  startDrag(): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.dragging() || this.dragBusy) return Promise.resolve(null);
    if (!this.canSend()) return Promise.resolve(this.blocked());
    this.dragBusy = true;
    this.starting = true;
    return this.runStart(this.account);
  }

  private async runStart(asked: string | null): Promise<PcFailure | null> {
    const epoch = ++this.downEpoch;
    try {
      // O aperto espera o movimento já enviado terminar (o dedo ficou parado até a pressão longa, então quase sempre já
      // terminou): o botão nunca é apertado antes de o ponteiro chegar onde o dedo parou. Se o movimento não termina no
      // prazo, o aperto é abandonado com um aviso (nada foi apertado).
      // O movimento feito depois fica retido já daqui (e até o aperto confirmar): o ponteiro só anda com o botão apertado.
      this.batcher.hold();
      if (!(await this.settleMoves())) return this.abandoned();
      // Os cliques que já saíram terminam antes do aperto (por até o mesmo prazo): o botão nunca é apertado por trás deles.
      if (!(await this.settleClicks())) {
        return this.abandoned(
          $localize`:@@pc.error.click-stuck:O PC não respondeu ao clique; o arrasto não foi enviado.`,
        );
      }
      // A conta trocou enquanto o movimento saía: o aperto era de outra pessoa e não vai ao PC desta.
      if (this.session.accountId() !== asked) return CANCELLED;
      // Pediram para soltar enquanto o movimento saía: apertar agora só para soltar é desperdício, e arriscado.
      if (this.releaseWanted) return null;
      this.maybeHeld = true;
      const failure = await this.run(async () => {
        const timedOut = await this.queueButton(() => this.downRequest(epoch, asked));
        if (timedOut) throw new HttpErrorResponse({ status: 504 });
      });
      if (this.session.accountId() !== asked) return failure;
      const wanted = this.releaseWanted;
      let released = false;
      if (failure !== null || wanted) {
        // Pediram para soltar: insiste um pouco (a pessoa já saiu; ninguém mais vai tentar de novo).
        released =
          (await this.upWithRetry(
            asked,
            wanted ? UP_RETRY_BACKOFF_MS.length + 1 : 1,
            this.releaseKeepalive,
          )) === null;
      }
      if (released) this.maybeHeld = false;
      // Apertou e ninguém pediu para soltar: a tela mostra o botão apertado. Se pediram e o `UP` não passou, ele NÃO volta a
      // ser mostrado como apertado (nem ganha sinal de vida): o agente solta o que ficar sem comandos.
      if (failure === null && !wanted) this.setDragging(true);
      return failure;
    } finally {
      this.releaseWanted = false;
      this.releaseKeepalive = false;
      this.starting = false;
      this.dragBusy = false;
      this.batcher.resume();
    }
  }

  /**
   * Solta o botão esquerdo se ele está, ou pode estar, apertado; sem botão apertado não faz nada. Funciona mesmo com o PC
   * marcado como desconectado (um `UP` a mais é inofensivo). Se o `DOWN` ainda está saindo, o `UP` vai quando ele
   * termina. Com `persistent` (ninguém mais vai tentar: saiu da tela, o dedo saiu) o `UP` é repetido se falhar.
   */
  async release(options: { readonly persistent?: boolean } = {}): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.starting) {
      this.releaseWanted = true;
      return null;
    }
    if (this.dragBusy || (!this.maybeHeld && !this.dragging())) return null;
    const asked = this.account;
    this.dragBusy = true;
    try {
      // O `UP` só sai depois de o último movimento chegar: o botão é solto onde o dedo terminou, não onde o ponteiro estava
      // quando o `UP` partiu. A espera tem teto para um pedido de movimento preso nunca deixar o botão apertado.
      await this.drainBeforeUp();
      if (this.session.accountId() !== asked) return CANCELLED;
      const failure = options.persistent
        ? await this.upWithRetry(asked, UP_RETRY_BACKOFF_MS.length + 1)
        : await this.run(() => this.queueButton(() => this.upRequest(asked)));
      if (!failure && this.session.accountId() === asked) {
        this.maybeHeld = false;
        this.setDragging(false);
      }
      return failure;
    } finally {
      this.dragBusy = false;
    }
  }

  /**
   * A tela usa para esconder o que o PC conectado não entende: o toque que cabe na `pc.key.v1` serve a qualquer agente; o que
   * precisa da v2 só aparece quando o agente a declarou. Não barra o envio (quem decide é a API, que enxerga o agente de agora,
   * e responde `key-unsupported` se ele não a entende): é só o que mostrar.
   */
  supportsKey(key: PcKey, options: PcKeyOptions = {}): boolean {
    return !keyNeedsV2(key, options) || this.supportsKeyV2();
  }

  /**
   * `options.repeat` aperta várias vezes num pedido só (Backspace e setas seguradas); `options.action` `DOWN` e `UP` seguram e
   * soltam um modificador entre toques. Um modificador segurado é solto pelo agente se a conexão cair ou se ficar 30 s sem
   * nenhum comando; quem segura precisa soltar com o `UP` e, enquanto isso, mandar o sinal de vida (um movimento zerado).
   */
  sendKey(
    key: PcKey,
    modifiers: readonly PcModifier[] = [],
    options: PcKeyOptions = {},
  ): Promise<PcFailure | null> {
    // Segurar e soltar têm caminho próprio: a soltura nunca pode ser cancelada pela fila de entrada.
    if (options.action === 'UP' && isHoldableKey(key)) return this.releaseKey(key);
    if (options.action === 'DOWN' && isHoldableKey(key)) return this.holdKey(key);
    return this.queueInput(() => this.api.key(key, modifiers, options));
  }

  /**
   * Segura um modificador (o Alt do Alt+Tab) até `releaseKey`. Entra na fila de entrada, na ordem dos toques. A tecla conta
   * como segurada já daqui: se a resposta se perde, o `DOWN` pode ter chegado, e a saída segura é soltar. Se o pedido nem
   * saiu (a fila foi cancelada), ela volta a não estar segurada.
   */
  async holdKey(key: PcHoldableKey): Promise<PcFailure | null> {
    this.syncAccount();
    if (!this.canSend()) return this.blocked();
    if (this.heldKeys().includes(key)) return null;
    // Sem a tela (saiu do módulo ou escondeu a página) ninguém solta o que for segurado agora.
    if (!this.heartbeatAllowed) return CANCELLED;
    this.keysOfOtherAccount = false;
    const asked = this.account;
    this.setKeyHeld(key, true);
    let skipped = false;
    const failure = await this.queueInput(() => {
      // O `DOWN` esperou na fila: se nesse meio tempo a tela saiu, a página se escondeu, a conta mudou ou a tecla já foi solta
      // (a soltura de sair e de esconder passou na frente dele), ele não vai mais, para o Alt nunca ficar preso no PC.
      if (
        !this.heartbeatAllowed ||
        this.session.accountId() !== asked ||
        !this.heldKeys().includes(key)
      ) {
        skipped = true;
        return Promise.resolve();
      }
      const down = this.api.key(key, [], { action: 'DOWN' });
      // A espera do `DOWN` tem prazo (e a soltura só espera `UP_DRAIN_MS`), mas o pedido de verdade segue no ar: quando ele
      // termina, se a tecla já foi solta (o `UP` pode ter passado na frente dele) ou o resultado ficou incerto, solta de novo.
      const settled = () => this.afterDown(key, asked);
      down.then(settled, settled);
      return down;
    });
    if (skipped) return CANCELLED;
    if (this.session.accountId() !== asked) return failure;
    if (failure === CANCELLED) this.setKeyHeld(key, false);
    else if (failure !== null) void this.releaseKey(key, { persistent: true });
    return failure;
  }

  /**
   * O `DOWN` de verdade terminou (bem ou mal). Se a tecla já não consta como segurada, o `UP` que a soltou pode ter chegado ao
   * PC antes dele, e o Alt ficaria preso: um `UP` a mais, que é inofensivo, resolve. Se ela ainda consta, quem a solta virá
   * depois deste pedido, na ordem certa.
   */
  private afterDown(key: PcHoldableKey, owner: string | null): void {
    if (this.session.accountId() !== owner || this.heldKeys().includes(key)) return;
    void this.keyUpWithRetry(key, owner, UP_RETRY_BACKOFF_MS.length + 1);
  }

  /**
   * Solta um modificador. O `UP` sempre sai, mesmo sem a tecla constar como segurada (um `UP` a mais é inofensivo, e o estado
   * daqui pode estar errado); só a troca de conta o dispensa (a tecla era do PC da outra conta). Rota e caminho próprios: nunca
   * passa pela fila de entrada (uma falha dela não o cancela) e funciona mesmo com o PC marcado como desconectado. Espera
   * o que já saiu por até `UP_DRAIN_MS` (para não passar na frente do próprio `DOWN`) e sai de qualquer jeito. Com
   * `persistent` (ninguém mais vai tentar: saiu da tela) repete se falhar e, se nada passar, desiste do estado: o agente solta
   * o que ficar 30 s sem comandos.
   */
  async releaseKey(
    key: PcHoldableKey,
    options: { readonly persistent?: boolean } = {},
  ): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.keysOfOtherAccount) {
      // A tecla era do PC da conta anterior: o `UP` não vai ao desta (e o agente de lá solta sozinho).
      this.keysOfOtherAccount = false;
      return null;
    }
    const asked = this.account;
    await raceTimeout(this.inputTail.then(ignore, ignore), UP_DRAIN_MS);
    if (this.session.accountId() !== asked) return CANCELLED;
    const failure = options.persistent
      ? await this.keyUpWithRetry(key, asked, UP_RETRY_BACKOFF_MS.length + 1)
      : await this.run(() => this.keyUpRequest(key, asked));
    if (this.session.accountId() === asked && (failure === null || options.persistent)) {
      this.setKeyHeld(key, false);
    }
    return failure;
  }

  /** Solta tudo o que está segurado (sair da tela, o dedo saiu). */
  async releaseHeldKeys(options: { readonly persistent?: boolean } = {}): Promise<void> {
    await Promise.all(this.heldKeys().map((key) => this.releaseKey(key, options)));
  }

  /** O `UP` de um modificador, só se a conta que o segurou ainda é a da sessão (senão iria ao PC de outra pessoa). */
  private keyUpRequest(key: PcHoldableKey, owner: string | null, keepalive = false): Promise<void> {
    this.assertAccount(owner);
    return keepalive ? this.api.keyRelease(key, { keepalive: true }) : this.api.keyRelease(key);
  }

  /** Tenta o `UP` do modificador até `attempts` vezes, sem aviso na tela; devolve a última falha ou `null`. Nunca lança. */
  private async keyUpWithRetry(
    key: PcHoldableKey,
    owner: string | null,
    attempts: number,
  ): Promise<PcFailure | null> {
    let failure: PcFailure | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await pause(UP_RETRY_BACKOFF_MS[attempt - 1] ?? 0);
        if (this.session.accountId() !== owner) return failure;
      }
      try {
        await this.keyUpRequest(key, owner);
        return null;
      } catch (error) {
        if (error instanceof AccountChanged) return CANCELLED;
        failure = pcFailureOf(error);
      }
    }
    return failure;
  }

  private setKeyHeld(key: PcHoldableKey, held: boolean): void {
    const current = this.heldKeys();
    if (held === current.includes(key)) return;
    this.heldKeys.set(held ? [...current, key] : current.filter((item) => item !== key));
    this.syncHeartbeat();
  }

  /** Esquece o que estava segurado, sem enviar nada (o PC se foi, a conta mudou, ou ninguém mais vai soltar). */
  private dropHeldKeys(): void {
    if (this.heldKeys().length === 0) return;
    this.heldKeys.set([]);
    this.syncHeartbeat();
  }

  sendText(text: string): Promise<PcFailure | null> {
    return this.queueInput(() => this.api.text(text));
  }

  /**
   * Uma edição do campo num pedido só (apagar, digitar e a tecla do fim), na ordem da fila de entrada. Só para um PC que
   * declarou `pc.text.v2`: quem chama confere (`supportsTextV2`).
   */
  sendTextEdit(edit: PcTextEdit): Promise<PcFailure | null> {
    return this.queueInput(() => this.api.edit(edit));
  }

  /**
   * Tem o mesmo prazo da fila de entrada (`INPUT_TIMEOUT_MS`): um pedido de mídia que não responde vira `timeout` em vez de
   * prender para sempre quem espera por ele (a faixa do volume manda um pedido por vez). Só a mídia: os outros comandos
   * (energia, abrir favorito) seguem sem esse prazo.
   */
  sendMedia(action: PcMediaAction, steps = 1): Promise<PcFailure | null> {
    return this.command(async () => {
      if (await raceTimeout(this.api.media(action, steps), INPUT_TIMEOUT_MS)) {
        throw new HttpErrorResponse({ status: 504 });
      }
    });
  }

  /** Suspender e desligar levam `confirm`: quem chama só o passa depois de a pessoa confirmar na folha. */
  power(action: PcPowerAction, confirm = false): Promise<PcFailure | null> {
    return this.command(() => this.api.power(action, confirm));
  }

  launch(appId: string): Promise<PcFailure | null> {
    return this.command(() => this.api.launch(appId));
  }

  /**
   * Põe um texto ou uma tecla na fila de entrada (ver `inputTail`). Devolve a falha do próprio pedido, ou `CANCELLED` se uma
   * falha anterior da fila (ou a troca de conta) o cancelou antes de sair: nesse caso nada foi enviado.
   */
  private queueInput(call: () => Promise<void>): Promise<PcFailure | null> {
    if (!this.canSend()) return Promise.resolve(this.blocked());
    const generation = this.inputGeneration;
    const run = this.inputTail.then(async (): Promise<PcFailure | null> => {
      if (generation !== this.inputGeneration) return CANCELLED;
      // O pedido que não responde no prazo vira `timeout` (resultado incerto) e a fila segue sem o que esperava atrás.
      const failure = await this.run(async () => {
        if (await raceTimeout(call(), INPUT_TIMEOUT_MS))
          throw new HttpErrorResponse({ status: 504 });
      });
      if (failure !== null) this.inputGeneration++;
      return failure;
    });
    this.inputTail = run.then(ignore, ignore);
    return run;
  }

  /** Espera os movimentos feitos até agora terminarem, por no máximo `UP_DRAIN_MS` (passou, solta mesmo assim). */
  private async drainBeforeUp(): Promise<void> {
    await this.settleMoves(UP_DRAIN_MS);
  }

  /**
   * Manda o que esperava e espera só os pedidos de movimento existentes agora, por até `limit`. Devolve `false` se o prazo
   * acabou antes (um pedido de movimento preso).
   */
  private async settleMoves(limit = MOVE_SETTLE_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), limit);
    });
    try {
      return await Promise.race([this.batcher.settleNow().then(() => true), giveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Espera os cliques que existem agora terminarem, por no máximo `MOVE_SETTLE_MS`. Devolve `false` se o prazo acabou antes
   * (um clique preso): o aperto é abandonado, como no movimento que não termina, em vez de sair por trás dele.
   */
  private async settleClicks(): Promise<boolean> {
    if (this.clicks.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), MOVE_SETTLE_MS);
    });
    try {
      return await Promise.race([Promise.allSettled([...this.clicks]).then(() => true), giveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** O clique (ou o aperto) desistiu por um movimento que não terminou: nada foi enviado, e a tela avisa. */
  private abandoned(
    message = $localize`:@@pc.error.move-stuck:O PC não acompanhou o movimento; o toque não foi enviado.`,
  ): PcFailure {
    const failure: PcFailure = { kind: 'timeout', message };
    this.noteFailure(failure);
    // Ele fica na tela por alguns segundos: os movimentos que vêm logo depois (e dão certo) não o apagam antes de ser lido.
    this.stickyNotice = failure;
    setTimeout(() => {
      if (this.stickyNotice !== failure) return;
      this.stickyNotice = null;
      if (this.notice() === failure) this.notice.set(null);
    }, ABANDONED_NOTICE_MS);
    return failure;
  }

  private async command(call: () => Promise<void>): Promise<PcFailure | null> {
    if (!this.canSend()) return this.blocked();
    return this.run(call);
  }

  private async run(call: () => Promise<void>): Promise<PcFailure | null> {
    try {
      await call();
      return null;
    } catch (error) {
      // O pedido desistiu porque a conta mudou: nada de aviso nem de releitura do estado para a conta nova.
      if (error instanceof AccountChanged) return CANCELLED;
      const failure = pcFailureOf(error);
      this.noteFailure(failure);
      return failure;
    }
  }

  private blocked(): PcFailure {
    return this.phase() === 'offline'
      ? { kind: 'offline', message: $localize`:@@pc.error.offline:O PC está desconectado.` }
      : {
          kind: 'unavailable',
          message: $localize`:@@pc.error.unavailable:Nenhum PC com o controle ligado.`,
        };
  }

  /**
   * Se a conta mudou desde que o estado daqui foi guardado, joga fora a fila e o aguardo da taxa do movimento, a fração
   * do acelerador, o aviso e o "Arrastar" ligado. O botão apertado era no PC da conta anterior, que daqui já não se alcança
   * (um pedido sairia com a sessão nova, para o PC errado): nada é enviado, o estado é zerado para o próximo toque apertar,
   * não soltar, e o agente solta sozinho o botão que ficar sem comandos. Todo `UP` em fila, repetido ou atrasado confere a
   * conta e desiste se ela mudou. Não esvazia a fila: o que esperava nunca deve sair.
   */
  private syncAccount(): void {
    const current = this.session.accountId();
    if (current === this.account) return;
    this.maybeHeld = false;
    this.releaseWanted = false;
    this.releaseKeepalive = false;
    this.inputGeneration++;
    this.account = current;
    this.batcher.discard();
    this.accelerator.reset();
    this.scroller.reset();
    this.setDragging(false);
    // O modificador segurado era no PC da conta anterior: nada é enviado para o desta; o agente o solta sozinho.
    if (this.heldKeys().length > 0) this.keysOfOtherAccount = true;
    this.dropHeldKeys();
    this.notice.set(null);
  }

  /** Marca o botão como apertado (ou solto) na tela e liga (ou desliga) o sinal de vida que o mantém. */
  private setDragging(value: boolean): void {
    this.dragging.set(value);
    this.syncHeartbeat();
  }

  /** O botão do mouse apertado ou um modificador segurado: o que o sinal de vida mantém. */
  private holding(): boolean {
    return this.dragging() || this.heldKeys().length > 0;
  }

  private syncHeartbeat(): void {
    if (this.holding()) this.startHeartbeat();
    else this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null || !this.heartbeatAllowed) return;
    this.heartbeat = window.setInterval(() => void this.beat(), HOLD_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Movimento zerado: não mexe o ponteiro, só mostra ao agente que o botão apertado é de propósito. */
  private async beat(): Promise<void> {
    if (!this.heartbeatAllowed || !this.holding() || this.batcher.busy) return;
    // O botão apertado é de uma conta; o sinal de vida de outra sessão iria para o PC errado.
    if (this.session.accountId() !== this.account) return;
    try {
      await this.api.pointer(0, 0);
    } catch {
      // sem aviso na tela: o próximo sinal tenta de novo, e o agente solta o botão se a rede não voltar
    }
  }

  /** Põe um pedido do botão na fila: ele só parte quando o anterior terminou, de um jeito ou de outro. */
  private queueButton<T>(task: () => Promise<T>): Promise<T> {
    const run = this.buttonTail.then(task, task);
    this.buttonTail = run.then(ignore, ignore);
    return run;
  }

  /** Quando um pedido do botão chega a sua vez, a conta pode ter mudado: o pedido era dela, e desiste. */
  private assertAccount(owner: string | null): void {
    if (this.session.accountId() !== owner) throw new AccountChanged();
  }

  /** O `UP` da fila, só se a conta que apertou ainda é a da sessão (senão iria ao PC de outra pessoa). */
  private upRequest(owner: string | null, keepalive = false): Promise<void> {
    this.assertAccount(owner);
    return keepalive
      ? this.api.click('LEFT', 'UP', { keepalive: true })
      : this.api.click('LEFT', 'UP');
  }

  /** O `DOWN`, com tempo limite; devolve se o tempo acabou. Se ele ainda responder depois, solta de novo (uma vez). */
  private async downRequest(epoch: number, owner: string | null): Promise<boolean> {
    this.assertAccount(owner);
    const call = this.api.click('LEFT', 'DOWN');
    const timedOut = await raceTimeout(call, DOWN_TIMEOUT_MS);
    if (timedOut) {
      call.then(() => {
        // O botão chegou a apertar depois de a tela ter desistido: só solta se nenhum aperto novo começou desde então e a
        // conta ainda é a mesma (`upRequest` confere de novo na vez do pedido).
        if (epoch === this.downEpoch && !this.dragging() && !this.starting) {
          void this.tryUp(owner);
        }
      }, ignore);
    }
    return timedOut;
  }

  /** `UP` do botão esquerdo, na fila e sem aviso na tela; devolve a falha, se houve. Nunca lança. */
  private async tryUp(owner: string | null, keepalive = false): Promise<PcFailure | null> {
    try {
      await this.queueButton(() => this.upRequest(owner, keepalive));
      return null;
    } catch (error) {
      // A conta mudou antes da vez do `UP`: desistência calada, não uma falha.
      return error instanceof AccountChanged ? CANCELLED : pcFailureOf(error);
    }
  }

  /**
   * Tenta o `UP` até `attempts` vezes, com as esperas de `UP_RETRY_BACKOFF_MS`; devolve a última falha ou `null`. Para de
   * tentar assim que a conta deixa de ser a que apertou o botão.
   */
  private async upWithRetry(
    owner: string | null,
    attempts: number,
    keepalive = false,
  ): Promise<PcFailure | null> {
    let failure: PcFailure | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await pause(UP_RETRY_BACKOFF_MS[attempt - 1] ?? 0);
        if (this.session.accountId() !== owner) return failure;
      }
      failure = await this.tryUp(owner, keepalive);
      if (failure === null) return null;
      // Desistiu porque a conta mudou: tentar de novo (e esperar para isso) seria inútil.
      if (failure === CANCELLED) return failure;
    }
    return failure;
  }

  /** `UP` de um modificador com `keepalive`, fora de qualquer fila (a página está sumindo); devolve se passou. Nunca lança. */
  private async keyUpNowKeepalive(key: PcHoldableKey): Promise<boolean> {
    try {
      await this.api.keyRelease(key, { keepalive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** `UP` imediato com `keepalive`, fora da fila (a página está morrendo); devolve se passou. Nunca lança. */
  private async quietUpNow(): Promise<boolean> {
    try {
      await this.api.click('LEFT', 'UP', { keepalive: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A página vai sumir (`pagehide`) ou foi para o segundo plano: solta o botão agora, com `keepalive` para o navegador
   * terminar o pedido mesmo se a página morrer. Síncrono de propósito: não há tempo de esperar o movimento pendente. Com o
   * `DOWN` ainda em voo o `UP` espera a vez dele na fila (e, se a página morre de vez, sai também um imediato).
   */
  private releaseOnHide(dying: boolean): void {
    this.syncAccount();
    this.heartbeatAllowed = false;
    this.stopHeartbeat();
    // Os modificadores segurados saem já, cada um com o seu `keepalive` (nada espera a fila de entrada).
    for (const key of this.heldKeys()) {
      void this.keyUpNowKeepalive(key).then((ok) => {
        if (ok) this.setKeyHeld(key, false);
      });
    }
    if (this.starting) {
      // O `DOWN` ainda está saindo: um `UP` agora poderia passar na frente dele. O `UP` (com `keepalive`) é o próximo da
      // fila, assim que o `DOWN` terminar.
      this.releaseWanted = true;
      this.releaseKeepalive = true;
      // A página morre agora: o `UP` da fila pode nunca sair. Um `UP` imediato com `keepalive` vai também, sabendo que
      // ele pode passar na frente do `DOWN` (são pedidos independentes). O pior caso é um `DOWN` que chega depois do `UP`
      // e deixa o botão apertado; ele é limitado pela soltura automática do agente (30 s sem comandos) e, se a rede
      // demorar mais de 5 s, o agente rejeita o `DOWN` velho. Só no `pagehide` definitivo.
      if (dying && this.maybeHeld) void this.quietUpNow();
      return;
    }
    if (!this.maybeHeld && !this.dragging()) return;
    void this.quietUpNow().then((ok) => {
      if (!ok || this.starting) return;
      this.maybeHeld = false;
      this.setDragging(false);
    });
  }

  private async sendPointer(batch: PointerBatch): Promise<boolean> {
    // Um movimento agendado por uma conta não sai depois que a aba virou outra.
    if (this.session.accountId() !== this.account) {
      this.syncAccount();
      return false;
    }
    try {
      await this.api.pointer(batch.dx, batch.dy, batch.scrollX, batch.scrollY, batch.seq);
      if (this.stickyNotice === null) this.notice.set(null);
      return true;
    } catch (error) {
      this.noteFailure(pcFailureOf(error));
      return false;
    }
  }

  /** Um PC que sumiu (ou deixou de ter o controle) muda a tela na hora, sem esperar a próxima leitura. */
  private noteFailure(failure: PcFailure): void {
    this.stickyNotice = null; // uma falha mais nova substitui o aviso que estava preso
    this.notice.set(failure);
    // Também quando o agente foi atualizado (ou trocado) depois da última leitura: as capacidades que a tela mostra vêm dela.
    if (
      failure.kind === 'offline' ||
      failure.kind === 'unavailable' ||
      failure.kind === 'key-unsupported'
    )
      void this.availability.refresh();
  }
}
