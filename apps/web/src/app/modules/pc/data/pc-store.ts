import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { PointerAccelerator, ScrollAccelerator, accelerationFor } from '../input/pc-acceleration';
import { PointerBatch, PointerBatcher } from '../input/pointer-batcher';
import { PcApi } from './pc-api';
import { PcFailure, pcFailureOf } from './pc-failure';
import { PcPrefs } from './pc-prefs';
import type { PcClickButton, PcKey, PcMediaAction, PcModifier, PcPowerAction } from './pc-types';

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

/** Falha o pedido com um 504 se ele não terminar a tempo (o pedido em si segue; só a espera acaba). */
function withTimeout(call: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HttpErrorResponse({ status: 504 })), ms);
    call.then(
      () => {
        clearTimeout(timer);
        resolve();
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
 * o movimento do dedo passa pela aceleração e pelo `PointerBatcher` (um pedido em voo por vez); os demais comandos são um
 * pedido cada e devolvem a falha, quando há, para quem os chamou mostrar onde faz sentido.
 *
 * O botão esquerdo apertado (arrastar) é o único estado que fica preso no PC se a tela sumir: por isso ele é solto ao sair
 * da tela, ao esconder ou fechar a página, ao trocar de conta e quando o aperto falha ou fica sem resposta.
 */
@Injectable({ providedIn: 'root' })
export class PcStore {
  private readonly api = inject(PcApi);
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);
  private readonly prefs = inject(PcPrefs);
  /** A conta de quem é o estado de movimento e de arrastar guardado aqui (o store vive a aba toda, as contas não). */
  private account = this.session.accountId();
  private readonly accelerator = new PointerAccelerator();
  private readonly scroller = new ScrollAccelerator();
  private readonly batcher = new PointerBatcher((batch) => this.sendPointer(batch));
  /** Um `DOWN` foi pedido e o `UP` ainda não foi confirmado: o botão pode estar apertado no PC. */
  private maybeHeld = false;
  /** Há um `DOWN` ou um `UP` a caminho (barra o segundo toque do "Arrastar"). */
  private dragBusy = false;
  /** O `DOWN` ainda está saindo (do início da espera pelo movimento até a resposta). */
  private starting = false;
  private heartbeat: number | null = null;
  /** Pediram para soltar enquanto o `DOWN` saía: assim que ele termina, o `UP` segue. */
  private releaseWanted = false;

  /** A última falha de um movimento (os cliques e teclas devolvem a própria falha). Some ao próximo sucesso. */
  readonly notice = signal<PcFailure | null>(null);
  /** O botão esquerdo está apertado (arrastar). */
  readonly dragging = signal(false);

  readonly phase = computed<PcPhase>(() => {
    const status = this.availability.status();
    if (status === null) return 'loading';
    if (!status.available) return 'unavailable';
    return status.online ? 'ready' : 'offline';
  });
  readonly canSend = computed(() => this.phase() === 'ready');
  readonly apps = this.availability.apps;

  constructor() {
    // Trocar de conta (sair e entrar como outra pessoa, sem recarregar) descarta o que era da anterior, mesmo sem uso.
    effect(() => {
      this.session.accountId();
      untracked(() => this.syncAccount());
    });
  }

  /**
   * A tela chama ao abrir: relê o estado já e depois a cada `PC_POLL_MS` (só com a aba visível). Devolve a função que
   * encerra o acompanhamento.
   */
  watch(destroy?: DestroyRef): () => void {
    void this.availability.refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.availability.refresh();
    }, PC_POLL_MS);
    // Fechar o PWA ou ir para o segundo plano não pode deixar o botão apertado no PC (o iOS nem avisa o componente).
    const onHide = () => this.releaseOnHide();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void this.availability.refresh();
        // O botão continua apertado (o soltar ao esconder não passou): o sinal de vida volta.
        if (this.dragging()) this.startHeartbeat();
      } else onHide();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);
    const stop = () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
      this.endGesture();
      this.stopHeartbeat();
      void this.release();
    };
    destroy?.onDestroy(stop);
    return stop;
  }

  refresh(): Promise<boolean> {
    return this.availability.refresh();
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
   * O sentido segue a escolha "inverter rolagem".
   */
  scrollPointer(dx: number, dy: number, elapsedMs = 16): void {
    this.syncAccount();
    if (!this.canSend()) return;
    const wheel = this.scroller.apply(dx, dy, elapsedMs, this.prefs.invertScroll());
    if (wheel.scrollX !== 0 || wheel.scrollY !== 0) {
      this.batcher.addScroll(wheel.scrollX, wheel.scrollY);
    }
  }

  /** Clique depois de todo movimento que já saiu (a ordem do que o dedo fez é a do que o PC recebe). */
  async click(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
  ): Promise<PcFailure | null> {
    this.syncAccount();
    if (!this.canSend()) return this.blocked();
    const asked = this.account;
    await this.batcher.drain();
    // A conta trocou enquanto o movimento saía: o clique era de outra pessoa e não vai ao PC desta.
    if (this.session.accountId() !== asked) return this.blocked();
    return this.run(() => this.api.click(button, action));
  }

  /** Aperta o botão esquerdo e o mantém (arrastar); chamar de novo solta. Um segundo toque com o pedido a caminho é ignorado. */
  async toggleDrag(): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.dragBusy) return null;
    return this.dragging() ? this.release() : this.startDrag();
  }

  /**
   * Aperta o botão esquerdo e o mantém até `release()`. Se o aperto falhar ou ficar sem resposta, ele pode ter chegado ao
   * PC: manda o `UP` logo em seguida (soltar nunca faz mal).
   */
  async startDrag(): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.dragging() || this.dragBusy) return null;
    if (!this.canSend()) return this.blocked();
    const asked = this.account;
    this.dragBusy = true;
    this.starting = true;
    try {
      await this.batcher.drain();
      // A conta trocou enquanto o movimento saía: o aperto era de outra pessoa e não vai ao PC desta.
      if (this.session.accountId() !== asked) return this.blocked();
      this.maybeHeld = true;
      const failure = await this.run(() =>
        withTimeout(this.api.click('LEFT', 'DOWN'), DOWN_TIMEOUT_MS),
      );
      if (this.session.accountId() !== asked) return failure;
      const releaseNow = failure !== null || this.releaseWanted;
      const released = releaseNow ? await this.quietUp() : false;
      if (released) this.maybeHeld = false;
      // Apertou, ninguém pediu para soltar (ou o `UP` não passou): a tela mostra o botão apertado.
      if (!failure && !released) this.setDragging(true);
      return failure;
    } finally {
      this.releaseWanted = false;
      this.starting = false;
      this.dragBusy = false;
    }
  }

  /**
   * Solta o botão esquerdo se ele está, ou pode estar, apertado; sem botão apertado não faz nada. Funciona mesmo com o PC
   * marcado como desconectado (um `UP` a mais é inofensivo). Se o `DOWN` ainda está saindo, o `UP` vai quando ele terminar.
   */
  async release(): Promise<PcFailure | null> {
    this.syncAccount();
    if (this.starting) {
      this.releaseWanted = true;
      return null;
    }
    if (this.dragBusy || (!this.maybeHeld && !this.dragging())) return null;
    const asked = this.account;
    this.dragBusy = true;
    try {
      const failure = await this.run(() => this.api.click('LEFT', 'UP'));
      if (!failure && this.session.accountId() === asked) {
        this.maybeHeld = false;
        this.setDragging(false);
      }
      return failure;
    } finally {
      this.dragBusy = false;
    }
  }

  sendKey(key: PcKey, modifiers: readonly PcModifier[] = []): Promise<PcFailure | null> {
    return this.command(() => this.api.key(key, modifiers));
  }

  sendText(text: string): Promise<PcFailure | null> {
    return this.command(() => this.api.text(text));
  }

  sendMedia(action: PcMediaAction, steps = 1): Promise<PcFailure | null> {
    return this.command(() => this.api.media(action, steps));
  }

  /** Suspender e desligar levam `confirm`: quem chama só o passa depois de a pessoa confirmar na folha. */
  power(action: PcPowerAction, confirm = false): Promise<PcFailure | null> {
    return this.command(() => this.api.power(action, confirm));
  }

  launch(appId: string): Promise<PcFailure | null> {
    return this.command(() => this.api.launch(appId));
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
   * (o pedido sai com a sessão nova): o `UP` vai assim mesmo, que é inofensivo, e o estado é zerado para o próximo toque
   * apertar, não soltar. Não esvazia a fila: o que esperava nunca deve sair.
   */
  private syncAccount(): void {
    const current = this.session.accountId();
    if (current === this.account) return;
    if (this.maybeHeld || this.dragging()) void this.quietUp();
    this.maybeHeld = false;
    this.releaseWanted = false;
    this.account = current;
    this.batcher.discard();
    this.accelerator.reset();
    this.scroller.reset();
    this.setDragging(false);
    this.notice.set(null);
  }

  /** Marca o botão como apertado (ou solto) na tela e liga (ou desliga) o sinal de vida que o mantém. */
  private setDragging(value: boolean): void {
    this.dragging.set(value);
    if (value) this.startHeartbeat();
    else this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = window.setInterval(() => void this.beat(), HOLD_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Movimento zerado: não mexe o ponteiro, só mostra ao agente que o botão apertado é de propósito. */
  private async beat(): Promise<void> {
    if (!this.dragging() || this.batcher.busy) return;
    try {
      await this.api.pointer(0, 0);
    } catch {
      // sem aviso na tela: o próximo sinal tenta de novo, e o agente solta o botão se a rede não voltar
    }
  }

  /** `UP` do botão esquerdo sem aviso na tela; devolve se passou. Nunca lança. */
  private async quietUp(keepalive = false): Promise<boolean> {
    try {
      await (keepalive
        ? this.api.click('LEFT', 'UP', { keepalive: true })
        : this.api.click('LEFT', 'UP'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A página vai sumir (`pagehide`) ou foi para o segundo plano: solta o botão agora, com `keepalive` para o navegador
   * terminar o pedido mesmo se a página morrer. Síncrono de propósito: não há tempo de esperar o movimento pendente.
   */
  private releaseOnHide(): void {
    if (this.starting) this.releaseWanted = true;
    this.stopHeartbeat();
    if (!this.maybeHeld && !this.dragging()) return;
    void this.quietUp(true).then((ok) => {
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
      await this.api.pointer(batch.dx, batch.dy, batch.scrollX, batch.scrollY);
      this.notice.set(null);
      return true;
    } catch (error) {
      this.noteFailure(pcFailureOf(error));
      return false;
    }
  }

  /** Um PC que sumiu (ou deixou de ter o controle) muda a tela na hora, sem esperar a próxima leitura. */
  private noteFailure(failure: PcFailure): void {
    this.notice.set(failure);
    if (failure.kind === 'offline' || failure.kind === 'unavailable')
      void this.availability.refresh();
  }
}
