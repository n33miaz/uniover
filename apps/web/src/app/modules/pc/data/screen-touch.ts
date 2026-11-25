import type { PadTimers } from '../input/pad-gesture';
import type { ScreenMonitor } from './screen-viewer';

/** O PC declara isto quando entende o toque na imagem da tela (`pc.tap.v1` e `pc.pointer.abs.v1`). */
export const PC_ABS_CAPABILITY = 'pc.abs.v1';

/** O maior `u` ou `v` do contrato: a última linha ou coluna de pixels do monitor. */
export const RELATIVE_MAX = 65_535;

/** Um ponto em pixels do quadro mostrado na tela do celular (origem no canto de cima à esquerda). */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** O que vai ao PC: o monitor, a posição relativa nele e o tamanho dele que o app viu em `s.mon`. */
export interface TapTarget {
  readonly m: number;
  readonly u: number;
  readonly v: number;
  readonly w: number;
  readonly h: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A posição do dedo sobre a imagem como `(m, u, v)`. `point` está em pixels do quadro mostrado (`box`), já sem o zoom
 * local; fora do quadro vale a borda. Ponto ou quadro sem sentido (NaN, tamanho zero) não vira alvo: o toque não sai.
 */
export function tapTarget(
  monitor: ScreenMonitor,
  point: TouchPoint,
  box: { readonly width: number; readonly height: number },
): TapTarget | null {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !(box.width > 0) ||
    !(box.height > 0)
  ) {
    return null;
  }
  return {
    m: monitor.id,
    u: Math.round(clamp(point.x / box.width, 0, 1) * RELATIVE_MAX),
    v: Math.round(clamp(point.y / box.height, 0, 1) * RELATIVE_MAX),
    w: monitor.width,
    h: monitor.height,
  };
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * O zoom e o deslocamento locais da imagem (pinça): só mudam como a imagem é mostrada, nada vai ao PC. `toImage` leva um
 * ponto do quadro (com o zoom) de volta ao ponto da imagem inteira, que é o que o toque manda.
 */
export class ImageView {
  scale = MIN_ZOOM;
  panX = 0;
  panY = 0;

  constructor(
    private width: number,
    private height: number,
  ) {}

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.limit();
  }

  reset(): void {
    this.scale = MIN_ZOOM;
    this.panX = 0;
    this.panY = 0;
  }

  /** `factor` multiplica o zoom em torno de `center`; `dx` e `dy` deslocam a imagem junto com os dedos. */
  pinch(factor: number, center: TouchPoint, dx: number, dy: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const next = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = next / this.scale;
    this.panX = center.x - (center.x - this.panX) * ratio + dx;
    this.panY = center.y - (center.y - this.panY) * ratio + dy;
    this.scale = next;
    this.limit();
  }

  toImage(point: TouchPoint): TouchPoint {
    return { x: (point.x - this.panX) / this.scale, y: (point.y - this.panY) / this.scale };
  }

  /** A imagem nunca sai do quadro: com zoom, as bordas vão até a borda do quadro e não além. */
  private limit(): void {
    this.panX = clamp(this.panX, this.width * (1 - this.scale), 0);
    this.panY = clamp(this.panY, this.height * (1 - this.scale), 0);
  }
}

export type TouchButton = 'LEFT' | 'RIGHT';
export type TouchAction = 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP';

export interface ScreenTouchHandlers {
  /** Um clique no ponto (ou o aperto e a soltura do arrasto: `DOWN` e `UP`). */
  tap(button: TouchButton, action: TouchAction, at: TouchPoint): void;
  /** O dedo que arrasta andou: a posição absoluta nova. */
  drag(at: TouchPoint): void;
  /** Dois dedos fora do modo "Rolar": zoom e deslocamento da imagem. */
  pinch(factor: number, center: TouchPoint, dx: number, dy: number): void;
  /** Dois dedos no modo "Rolar": o deslocamento do centro, em pixels do quadro. */
  scroll(dx: number, dy: number): void;
}

export interface ScreenTouchConfig {
  /** Quanto o dedo pode andar (px) e ainda ser um toque parado. */
  readonly slopPx: number;
  /** Um toque só vale como clique se durar menos que isto (ms). */
  readonly tapMaxMs: number;
  /** Um dedo parado por tanto tempo (ms) é o clique direito. */
  readonly longPressMs: number;
  /** Até quanto tempo (ms) depois de um toque o seguinte é o segundo do toque duplo. */
  readonly doubleTapMs: number;
  /** O segundo toque precisa pousar a menos que isto (px) do primeiro. */
  readonly doubleTapRadiusPx: number;
  /** No segundo toque, o dedo parado por tanto tempo (ms) já aperta o botão (arrasto). */
  readonly dragHoldMs: number;
}

export const DEFAULT_SCREEN_TOUCH: ScreenTouchConfig = {
  slopPx: 10,
  tapMaxMs: 260,
  longPressMs: 450,
  doubleTapMs: 280,
  doubleTapRadiusPx: 36,
  dragHoldMs: 180,
};

const SYSTEM_TIMERS: PadTimers = {
  set: (handler, ms) => globalThis.setTimeout(handler, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Phase =
  | 'idle'
  /** Um dedo no primeiro toque: pode virar clique, clique direito ou nada. */
  | 'first'
  /** Um dedo no segundo toque: pode virar clique duplo ou arrasto. */
  | 'second'
  | 'dragging'
  /** O toque já fez o que tinha de fazer (clique direito) ou foi cancelado: espera os dedos saírem. */
  | 'spent'
  | 'multi';

/**
 * Os gestos na imagem da tela do PC (seção "controle por toque"), sem tocar no DOM (testa-se com números):
 *  - toque: clique esquerdo ali (sai depois da espera do toque duplo, para não virar clique e clique duplo);
 *  - toque longo parado: clique direito;
 *  - dois toques seguidos: clique duplo;
 *  - segundo toque que fica ou anda: arrasto (`DOWN`, posições, `UP`);
 *  - dois dedos: zoom e deslocamento da imagem, ou rolagem no modo "Rolar".
 * O botão nunca fica preso: o gesto que acaba (dedo que sai, cancelado, outro dedo que pousa) solta o que apertou.
 */
export class ScreenTouch {
  private readonly fingers = new Map<number, TouchPoint>();
  private phase: Phase = 'idle';
  private origin: TouchPoint = { x: 0, y: 0 };
  private last: TouchPoint = { x: 0, y: 0 };
  private startedAt = 0;
  private timer: unknown = null;
  /** O primeiro toque que espera para saber se vira clique duplo. */
  private pending: { at: TouchPoint; time: number; timer: unknown } | null = null;
  private center: TouchPoint | null = null;
  private spread = 0;
  scrolling = false;

  constructor(
    private readonly handlers: ScreenTouchHandlers,
    private readonly config: ScreenTouchConfig = DEFAULT_SCREEN_TOUCH,
    private readonly timers: PadTimers = SYSTEM_TIMERS,
  ) {}

  get dragging(): boolean {
    return this.phase === 'dragging';
  }

  get active(): boolean {
    return this.fingers.size > 0;
  }

  down(id: number, x: number, y: number, timeMs: number): void {
    if (this.fingers.has(id)) return;
    const at = { x, y };
    if (this.fingers.size === 0) {
      this.origin = at;
      this.last = at;
      this.startedAt = timeMs;
      const first = this.pending;
      if (first && this.near(first.at, at) && timeMs - first.time <= this.config.doubleTapMs) {
        this.timers.clear(first.timer);
        this.pending = null;
        this.phase = 'second';
        this.hold(this.config.dragHoldMs, () => this.startDrag());
      } else {
        this.flush();
        this.phase = 'first';
        this.hold(this.config.longPressMs, () => this.longPress());
      }
      this.fingers.set(id, at);
      return;
    }
    this.fingers.set(id, at);
    if (this.fingers.size === 2) this.beginMulti();
  }

  move(id: number, x: number, y: number): void {
    if (!this.fingers.has(id)) return;
    const at = { x, y };
    this.fingers.set(id, at);
    if (this.fingers.size === 1) this.last = at;
    switch (this.phase) {
      case 'multi':
        this.moveMulti();
        return;
      case 'dragging':
        this.last = at;
        this.handlers.drag(at);
        return;
      case 'second':
        if (this.far(at)) this.startDrag();
        return;
      case 'first':
        // Andou: não é um toque parado (nem clique, nem clique direito).
        if (this.far(at)) {
          this.cancelTimer();
          this.phase = 'spent';
        }
        return;
      default:
        return;
    }
  }

  up(id: number, timeMs: number): void {
    const finger = this.fingers.get(id);
    if (!finger) return;
    this.fingers.delete(id);
    switch (this.phase) {
      case 'first':
        this.cancelTimer();
        if (timeMs - this.startedAt <= this.config.tapMaxMs) this.waitDouble(finger, timeMs);
        this.phase = 'idle';
        break;
      case 'second':
        this.cancelTimer();
        this.phase = 'idle';
        if (timeMs - this.startedAt <= this.config.tapMaxMs) {
          this.handlers.tap('LEFT', 'DOUBLE', finger);
        } else {
          // Segurou e soltou sem andar: o botão já foi apertado pelo tempo (`startDrag`), então não chega aqui.
          this.handlers.tap('LEFT', 'CLICK', finger);
        }
        break;
      case 'dragging':
        this.phase = 'idle';
        this.handlers.tap('LEFT', 'UP', finger);
        break;
      case 'multi':
        if (this.fingers.size < 2) this.endMulti();
        return;
      case 'spent':
        this.phase = 'idle';
        break;
      default:
        break;
    }
    if (this.fingers.size === 0) this.phase = 'idle';
  }

  /** O sistema tomou o gesto (ou a tela fechou): solta o que estiver apertado e esquece os dedos. */
  cancel(): void {
    this.cancelTimer();
    this.flushPending(false);
    if (this.phase === 'dragging') this.handlers.tap('LEFT', 'UP', this.last);
    this.fingers.clear();
    this.phase = 'idle';
    this.center = null;
  }

  /** Esquece o toque que esperava o segundo (a tela mudou: um clique atrasado cairia no lugar errado). */
  discardPending(): void {
    this.flushPending(false);
  }

  private waitDouble(at: TouchPoint, time: number): void {
    const timer = this.timers.set(() => {
      const first = this.pending;
      this.pending = null;
      if (first) this.handlers.tap('LEFT', 'CLICK', first.at);
    }, this.config.doubleTapMs);
    this.pending = { at, time, timer };
  }

  /** Um novo toque longe do primeiro: o primeiro sai agora como clique. */
  private flush(): void {
    this.flushPending(true);
  }

  private flushPending(send: boolean): void {
    const first = this.pending;
    if (!first) return;
    this.timers.clear(first.timer);
    this.pending = null;
    if (send) this.handlers.tap('LEFT', 'CLICK', first.at);
  }

  private longPress(): void {
    this.timer = null;
    if (this.phase !== 'first' || this.fingers.size !== 1) return;
    this.phase = 'spent';
    this.handlers.tap('RIGHT', 'CLICK', this.origin);
  }

  private startDrag(): void {
    this.timer = null;
    if (this.phase !== 'second' || this.fingers.size !== 1) return;
    this.cancelTimer();
    this.phase = 'dragging';
    this.handlers.tap('LEFT', 'DOWN', this.origin);
    if (this.last !== this.origin) this.handlers.drag(this.last);
  }

  private hold(ms: number, run: () => void): void {
    this.cancelTimer();
    this.timer = this.timers.set(run, ms);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private far(at: TouchPoint): boolean {
    return Math.hypot(at.x - this.origin.x, at.y - this.origin.y) > this.config.slopPx;
  }

  private near(a: TouchPoint, b: TouchPoint): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) <= this.config.doubleTapRadiusPx;
  }

  private beginMulti(): void {
    this.cancelTimer();
    this.flushPending(false);
    // Um segundo dedo no meio do arrasto solta o botão antes de virar zoom: nada fica apertado.
    if (this.phase === 'dragging') this.handlers.tap('LEFT', 'UP', this.last);
    this.phase = 'multi';
    const [a, b] = [...this.fingers.values()];
    this.center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.spread = Math.hypot(a.x - b.x, a.y - b.y);
  }

  private moveMulti(): void {
    if (this.fingers.size < 2 || !this.center) return;
    const [a, b] = [...this.fingers.values()];
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const spread = Math.hypot(a.x - b.x, a.y - b.y);
    const dx = center.x - this.center.x;
    const dy = center.y - this.center.y;
    if (this.scrolling) {
      this.handlers.scroll(dx, dy);
    } else {
      this.handlers.pinch(this.spread > 0 ? spread / this.spread : 1, center, dx, dy);
    }
    this.center = center;
    this.spread = spread;
  }

  private endMulti(): void {
    this.center = null;
    // O que restou do gesto de dois dedos não vira toque nem arrasto: espera todos os dedos saírem.
    this.phase = this.fingers.size === 0 ? 'idle' : 'spent';
  }
}
