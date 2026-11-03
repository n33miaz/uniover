export type PadButton = 'LEFT' | 'RIGHT';

/** O que o touchpad pede ao resto do app; quem monta os pedidos HTTP é o `PcStore`. */
export interface PadHandlers {
  /** Passo do ponteiro em pixels do dedo (a aceleração é de quem recebe). `elapsedMs`: tempo desde o passo anterior. */
  move(dx: number, dy: number, elapsedMs: number): void;
  /** Deslize de dois dedos em pixels do centro entre os dois. */
  scroll(dx: number, dy: number): void;
  /** Toque curto e parado: um dedo é o clique esquerdo, dois dedos o direito. */
  tap(button: PadButton): void;
}

export interface PadGestureConfig {
  /** Deslocamento (px) que ainda conta como o dedo parado; passou disto, vira movimento. */
  readonly slopPx: number;
  /** Um toque só vale como clique se durar menos que isto (ms). */
  readonly tapMaxMs: number;
}

export const DEFAULT_PAD_GESTURE: PadGestureConfig = { slopPx: 6, tapMaxMs: 260 };

interface Point {
  x: number;
  y: number;
}

/**
 * Leitura dos dedos no touchpad, sem tocar no DOM (para testar com números):
 *  - um dedo que anda move o ponteiro; um toque curto e parado clica com o botão esquerdo;
 *  - dois dedos que andam juntos rolam; um toque curto e parado dos dois clica com o direito.
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

  constructor(
    private readonly handlers: PadHandlers,
    private readonly config: PadGestureConfig = DEFAULT_PAD_GESTURE,
  ) {}

  get active(): boolean {
    return this.fingers.size > 0;
  }

  down(id: number, x: number, y: number, timeMs: number): void {
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
  }

  move(id: number, x: number, y: number, timeMs: number): void {
    const finger = this.fingers.get(id);
    if (!finger) return;
    finger.x = x;
    finger.y = y;

    const center = this.center()!;
    const last = this.lastCenter ?? center;
    this.lastCenter = center;

    if (!this.displaced) {
      if (Math.hypot(center.x - this.origin.x, center.y - this.origin.y) <= this.config.slopPx) {
        return;
      }
      this.displaced = true;
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
    const quick = timeMs - this.startedAt < this.config.tapMaxMs;
    if (!quick || this.displaced) return;
    if (this.peak === 1) this.handlers.tap('LEFT');
    else if (this.peak === 2) this.handlers.tap('RIGHT');
  }

  cancel(): void {
    this.fingers.clear();
    this.lastCenter = null;
    this.displaced = false;
  }

  private emit(dx: number, dy: number, timeMs: number): void {
    const elapsed = timeMs - this.lastStepAt;
    this.lastStepAt = timeMs;
    if (this.peak >= 2) this.handlers.scroll(dx, dy);
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
