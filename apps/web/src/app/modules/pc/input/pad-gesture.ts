export type PadButton = 'LEFT' | 'RIGHT';

/** O que o touchpad pede ao resto do app; quem monta os pedidos HTTP é o `PcStore`. */
export interface PadHandlers {
  /** Passo do ponteiro em pixels do dedo (a aceleração é de quem recebe). `elapsedMs`: tempo desde o passo anterior. */
  move(dx: number, dy: number, elapsedMs: number): void;
  /** Deslize de dois dedos em pixels do centro entre os dois. `elapsedMs`: tempo desde o passo anterior. */
  scroll(dx: number, dy: number, elapsedMs: number): void;
  /** Toque curto e parado: um dedo é o clique esquerdo, dois dedos o direito. */
  tap(button: PadButton): void;
  /** Um dedo ficou parado tempo bastante: aperta o botão esquerdo (começa a arrastar). */
  dragStart(): void;
  /** O dedo que arrastava saiu (ou o gesto foi tomado pelo sistema): solta o botão esquerdo. */
  dragEnd(): void;
}

/** Quem marca o tempo da pressão longa (troca-se nos testes). */
export interface PadTimers {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: PadTimers = {
  set: (handler, ms) => globalThis.setTimeout(handler, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PadGestureConfig {
  /** Deslocamento (px) que ainda conta como o dedo parado; passou disto, vira movimento. */
  readonly slopPx: number;
  /** Um toque só vale como clique se durar menos que isto (ms). */
  readonly tapMaxMs: number;
  /** Um dedo parado por tanto tempo (ms) aperta o botão esquerdo e o segura até sair. */
  readonly longPressMs: number;
  /** Durante a espera da pressão longa o dedo precisa ficar a menos que isto (px) de onde pousou; saiu, não é pressão. */
  readonly longPressRadiusPx: number;
}

/** Quanto tempo o dedo fica parado até apertar o botão (um toque lento de propósito não pode virar arrasto). */
export const LONG_PRESS_MS = 600;
/** O quanto o dedo pode tremer durante a espera. */
export const LONG_PRESS_RADIUS_PX = 4;

export const DEFAULT_PAD_GESTURE: PadGestureConfig = {
  slopPx: 6,
  tapMaxMs: 260,
  longPressMs: LONG_PRESS_MS,
  longPressRadiusPx: LONG_PRESS_RADIUS_PX,
};

interface Point {
  x: number;
  y: number;
}

/**
 * Leitura dos dedos no touchpad, sem tocar no DOM (para testar com números):
 *  - um dedo que anda move o ponteiro; um toque curto e parado clica com o botão esquerdo;
 *  - dois dedos que andam juntos rolam; um toque curto e parado dos dois clica com o direito.
 *  - um dedo que fica parado por `longPressMs` aperta o botão esquerdo; mexer o dedo arrasta, e sair solta (sem clique).
 * Depois que um segundo dedo pousa, o gesto fica sendo "de dois dedos" até todos saírem (levantar um dedo no meio da
 * rolagem não vira movimento do ponteiro por engano). Enquanto o dedo não passa de `slopPx` a partir de onde pousou, nada
 * se mexe; ao passar, o que ele já andou entra de uma vez, sem um salto perdido.
 */
export class PadGesture {
  private readonly fingers = new Map<number, Point>();
  private origin: Point = { x: 0, y: 0 };
  private lastCenter: Point | null = null;
  private startedAt = 0;
  private lastStepAt = 0;
  private peak = 0;
  private displaced = false;
  private holding = false;
  private pressTimer: unknown = null;

  constructor(
    private readonly handlers: PadHandlers,
    private readonly config: PadGestureConfig = DEFAULT_PAD_GESTURE,
    private readonly timers: PadTimers = SYSTEM_TIMERS,
  ) {}

  /** O botão está apertado por uma pressão longa deste gesto. */
  get dragging(): boolean {
    return this.holding;
  }

  get active(): boolean {
    return this.fingers.size > 0;
  }

  down(id: number, x: number, y: number, timeMs: number): void {
    // Com o botão apertado, um segundo dedo não vira rolagem no meio do arrasto: é ignorado.
    if (this.holding) return;
    if (this.fingers.size === 0) {
      this.startedAt = timeMs;
      this.lastStepAt = timeMs;
      this.peak = 0;
      this.displaced = false;
    }
    this.fingers.set(id, { x, y });
    this.peak = Math.max(this.peak, this.fingers.size);
    // A origem é a do conjunto dos dedos no instante em que o gesto passa a ser o atual (um dedo novo a reinicia).
    this.origin = this.center()!;
    this.lastCenter = this.origin;
    // Só um dedo parado vale como pressão longa: um segundo dedo ou o movimento desfazem a contagem.
    this.clearPress();
    if (this.fingers.size === 1)
      this.pressTimer = this.timers.set(() => this.longPress(), this.config.longPressMs);
  }

  move(id: number, x: number, y: number, timeMs: number): void {
    const finger = this.fingers.get(id);
    if (!finger) return;
    finger.x = x;
    finger.y = y;

    const center = this.center()!;
    const last = this.lastCenter ?? center;
    this.lastCenter = center;

    // Passou do raio de tremor: o dedo está andando, não pressionando (mesmo antes de passar do limite do movimento).
    if (
      this.pressTimer !== null &&
      Math.hypot(center.x - this.origin.x, center.y - this.origin.y) > this.config.longPressRadiusPx
    ) {
      this.clearPress();
    }

    if (!this.displaced) {
      if (Math.hypot(center.x - this.origin.x, center.y - this.origin.y) <= this.config.slopPx) {
        return;
      }
      this.displaced = true;
      this.clearPress();
      // O que andou até passar do limite entra agora, de uma vez.
      this.emit(center.x - this.origin.x, center.y - this.origin.y, timeMs);
      return;
    }
    this.emit(center.x - last.x, center.y - last.y, timeMs);
  }

  up(id: number, timeMs: number): void {
    if (!this.fingers.delete(id)) return;
    if (this.fingers.size > 0) {
      // Um dedo que sai muda o centro: sem refazer a referência o próximo passo daria um salto.
      this.lastCenter = this.center();
      return;
    }
    this.lastCenter = null;
    this.clearPress();
    if (this.holding) {
      this.holding = false;
      this.handlers.dragEnd();
      return;
    }
    const quick = timeMs - this.startedAt < this.config.tapMaxMs;
    if (!quick || this.displaced) return;
    if (this.peak === 1) this.handlers.tap('LEFT');
    else if (this.peak === 2) this.handlers.tap('RIGHT');
  }

  cancel(): void {
    this.fingers.clear();
    this.lastCenter = null;
    this.displaced = false;
    this.clearPress();
    if (this.holding) {
      this.holding = false;
      this.handlers.dragEnd();
    }
  }

  private longPress(): void {
    this.pressTimer = null;
    if (this.fingers.size !== 1 || this.displaced || this.holding) return;
    this.holding = true;
    this.handlers.dragStart();
  }

  private clearPress(): void {
    if (this.pressTimer === null) return;
    this.timers.clear(this.pressTimer);
    this.pressTimer = null;
  }

  private emit(dx: number, dy: number, timeMs: number): void {
    const elapsed = timeMs - this.lastStepAt;
    this.lastStepAt = timeMs;
    if (this.peak >= 2) this.handlers.scroll(dx, dy, elapsed);
    else this.handlers.move(dx, dy, elapsed);
  }

  private center(): Point | null {
    if (this.fingers.size === 0) return null;
    let x = 0;
    let y = 0;
    for (const finger of this.fingers.values()) {
      x += finger.x;
      y += finger.y;
    }
    return { x: x / this.fingers.size, y: y / this.fingers.size };
  }
}
