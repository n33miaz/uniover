import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { PointerAccelerator, wheelFromSwipe } from '../input/pc-acceleration';
import { PointerBatch, PointerBatcher } from '../input/pointer-batcher';
import { PcApi } from './pc-api';
import { PcFailure, pcFailureOf } from './pc-failure';
import type { PcClickButton, PcKey, PcMediaAction, PcModifier, PcPowerAction } from './pc-types';

/** De quanto em quanto tempo o estado do PC é relido enquanto a tela está aberta. */
export const PC_POLL_MS = 15_000;

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
 */
@Injectable({ providedIn: 'root' })
export class PcStore {
  private readonly api = inject(PcApi);
  private readonly availability = inject(PcAvailability);
  private readonly accelerator = new PointerAccelerator();
  private readonly batcher = new PointerBatcher((batch) => this.sendPointer(batch));

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

  /**
   * A tela chama ao abrir: relê o estado já e depois a cada `PC_POLL_MS` (só com a aba visível). Devolve a função que
   * encerra o acompanhamento.
   */
  watch(destroy?: DestroyRef): () => void {
    void this.availability.refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.availability.refresh();
    }, PC_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.availability.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    const stop = () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      this.endGesture();
    };
    destroy?.onDestroy(stop);
    return stop;
  }

  refresh(): Promise<boolean> {
    return this.availability.refresh();
  }

  /** Um dedo novo pousou: ele não herda a fração de pixel do anterior. */
  beginGesture(): void {
    this.accelerator.reset();
  }

  /** O dedo saiu: manda o que ainda esperava, para o ponteiro parar onde o dedo parou. */
  endGesture(): void {
    void this.batcher.drain();
  }

  /** Passo do dedo em pixels; a aceleração e o agrupamento são daqui. */
  movePointer(dx: number, dy: number, elapsedMs: number): void {
    if (!this.canSend()) return;
    const step = this.accelerator.apply(dx, dy, elapsedMs);
    if (step.dx !== 0 || step.dy !== 0) this.batcher.addMove(step.dx, step.dy);
  }

  /** Deslize de dois dedos em pixels do centro. */
  scrollPointer(dx: number, dy: number): void {
    if (!this.canSend()) return;
    const wheel = wheelFromSwipe(dx, dy);
    if (wheel.scrollX !== 0 || wheel.scrollY !== 0) {
      this.batcher.addScroll(wheel.scrollX, wheel.scrollY);
    }
  }

  /** Clique depois de todo movimento que já saiu (a ordem do que o dedo fez é a do que o PC recebe). */
  async click(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
  ): Promise<PcFailure | null> {
    if (!this.canSend()) return this.blocked();
    await this.batcher.drain();
    return this.run(() => this.api.click(button, action));
  }

  /** Aperta o botão esquerdo e o mantém (arrastar); chamar de novo solta. */
  async toggleDrag(): Promise<PcFailure | null> {
    const next = !this.dragging();
    const failure = await this.click('LEFT', next ? 'DOWN' : 'UP');
    if (!failure) this.dragging.set(next);
    return failure;
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

  private async sendPointer(batch: PointerBatch): Promise<boolean> {
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
