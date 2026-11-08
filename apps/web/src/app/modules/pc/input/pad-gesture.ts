export type PadButton = 'LEFT' | 'RIGHT' | 'MIDDLE';

/** Um ponto da tela, nas coordenadas do ponteiro (a tela diz onde mostrar o retorno do toque). */
export interface PadPoint {
  readonly x: number;
  readonly y: number;
}

/** O que o touchpad pede ao resto do app; quem monta os pedidos HTTP é o `PcStore`. */
export interface PadHandlers {
  /** Passo do ponteiro em pixels do dedo (a aceleração é de quem recebe). `elapsedMs`: tempo desde o passo anterior. */
  move(dx: number, dy: number, elapsedMs: number): void;
  /** Deslize de dois dedos em pixels do centro entre os dois. `elapsedMs`: tempo desde o passo anterior. */
  scroll(dx: number, dy: number, elapsedMs: number): void;
  /** Toque curto e parado: um dedo é o clique esquerdo, dois o direito, três o do meio. `at` é onde os dedos pousaram. */
  tap(button: PadButton, at: PadPoint): void;
  /** Um dedo ficou parado tempo bastante (ou tocou e logo andou, no arrasto com toque duplo): aperta o botão esquerdo. */
  dragStart(): void;
  /** O dedo que arrastava saiu (ou o gesto foi tomado pelo sistema): solta o botão esquerdo. */
  dragEnd(): void;
  /**
   * Os dois dedos saíram andando: a velocidade do centro deles em pixels por milissegundo, já com a trava de direção. Quem
   * quiser deixa a rolagem seguir sozinha (inércia); quem não implementa isto não perde nada.
   */
  scrollEnd?(vx: number, vy: number): void;
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
  /** Arrastar com toque duplo: o segundo toque, depois de um toque curto, começa a arrastar assim que o dedo anda. */
  readonly doubleTapDrag: boolean;
  /** Até quanto tempo (ms) depois de um toque o seguinte conta como o segundo do toque duplo. */
  readonly doubleTapMs: number;
  /** O segundo toque do toque duplo precisa pousar a menos que isto (px) do primeiro. */
  readonly doubleTapRadiusPx: number;
  /** Um toque curto de três dedos é o clique do meio. */
  readonly middleClick: boolean;
  /** A rolagem de dois dedos trava no eixo que dominou o começo do gesto (vertical ou horizontal). */
  readonly lockScrollAxis: boolean;
  /** Janela (ms) com que se mede a velocidade da rolagem na hora em que os dedos saem. */
  readonly velocityWindowMs: number;
}

/** O quanto o dedo pode andar sem que isso seja movimento (e sem que deixe de ser um toque ou uma pressão parada). */
export const PAD_SLOP_PX = 8;

/**
 * Quanto tempo o dedo fica parado até apertar o botão (um toque lento de propósito não pode virar arrasto). Era 600 ms
 * (0.43 a 0.46) e o dono achou longo demais; 450 ms fica acima do toque mais lento comum (o de 260 ms vale como clique)
 * e abaixo da impaciência. O valor é este e só este: quem quiser outro ritmo troca aqui.
 */
export const LONG_PRESS_MS = 450;
/** O quanto o dedo pode tremer durante a espera. */
export const LONG_PRESS_RADIUS_PX = PAD_SLOP_PX;

export const DEFAULT_PAD_GESTURE: PadGestureConfig = {
  slopPx: PAD_SLOP_PX,
  tapMaxMs: 260,
  longPressMs: LONG_PRESS_MS,
  longPressRadiusPx: LONG_PRESS_RADIUS_PX,
  doubleTapDrag: false,
  doubleTapMs: 300,
  doubleTapRadiusPx: 32,
  middleClick: true,
  lockScrollAxis: true,
  velocityWindowMs: 90,
};

/** Se o último passo da rolagem foi há mais que isto (ms) quando os dedos saem, eles pararam antes: nada de inércia. */
const FLING_FRESH_MS = 60;

interface Point {
  x: number;
  y: number;
}

interface ScrollSample {
  readonly at: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Leitura dos dedos no touchpad, sem tocar no DOM (para testar com números):
 *  - um dedo que anda move o ponteiro; um toque curto e parado clica com o botão esquerdo (na hora, sem esperar);
 *  - dois dedos que andam juntos rolam, presos ao eixo que dominou o começo; um toque curto e parado dos dois clica com o
 *    direito, e de três dedos com o do meio;
 *  - um dedo que fica parado por `longPressMs` aperta o botão esquerdo; mexer o dedo arrasta, e sair solta (sem clique);
 *  - com `doubleTapDrag`, tocar de novo logo depois de um toque e andar arrasta (o primeiro toque já clicou).
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
  /** O último toque curto de um dedo (onde e quando saiu), para o próximo ser o segundo do toque duplo. */
  private lastTap: { readonly at: Point; readonly time: number } | null = null;
  /** Este toque é o segundo do toque duplo: andar com ele começa a arrastar. */
  private doubleArmed = false;
  /** O eixo em que a rolagem de dois dedos travou; `null` até o primeiro passo. */
  private axis: 'x' | 'y' | null = null;
  private samples: ScrollSample[] = [];

  constructor(
    private readonly handlers: PadHandlers,
    private config: PadGestureConfig = DEFAULT_PAD_GESTURE,
    private readonly timers: PadTimers = SYSTEM_TIMERS,
  ) {}

  /** Troca ajustes que a pessoa muda sem recarregar a tela (valem do próximo toque em diante). */
  configure(
    patch: Partial<Pick<PadGestureConfig, 'doubleTapDrag' | 'middleClick' | 'lockScrollAxis'>>,
  ): void {
    this.config = { ...this.config, ...patch };
  }

  /** O botão está apertado por uma pressão longa (ou pelo arrasto com toque duplo) deste gesto. */
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
      this.axis = null;
      this.samples = [];
      this.doubleArmed = this.isSecondTap(x, y, timeMs);
      this.lastTap = null;
    }
    this.fingers.set(id, { x, y });
    this.peak = Math.max(this.peak, this.fingers.size);
    // O toque duplo é de um dedo só: um segundo dedo desarma (o gesto passa a ser outro).
    if (this.fingers.size > 1) this.doubleArmed = false;
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
      // Segundo toque do toque duplo que anda: aperta o botão antes do primeiro passo (o ponteiro só anda com ele apertado).
      if (this.doubleArmed && this.config.doubleTapDrag && this.fingers.size === 1) {
        this.holding = true;
        this.handlers.dragStart();
      }
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
    if (this.displaced) {
      if (this.peak >= 2) this.endScroll(timeMs);
      return;
    }
    if (timeMs - this.startedAt >= this.config.tapMaxMs) return;
    if (this.peak === 1) {
      this.handlers.tap('LEFT', this.origin);
      // O segundo toque de um toque duplo já usou o primeiro: um terceiro não encadeia.
      this.lastTap = this.doubleArmed ? null : { at: this.origin, time: timeMs };
    } else if (this.peak === 2) {
      this.handlers.tap('RIGHT', this.origin);
    } else if (this.peak === 3 && this.config.middleClick) {
      this.handlers.tap('MIDDLE', this.origin);
    }
  }

  cancel(): void {
    this.fingers.clear();
    this.lastCenter = null;
    this.displaced = false;
    this.lastTap = null;
    this.doubleArmed = false;
    this.samples = [];
    this.clearPress();
    if (this.holding) {
      this.holding = false;
      this.handlers.dragEnd();
    }
  }

  /** Este toque pousou perto e logo depois de um toque curto? */
  private isSecondTap(x: number, y: number, timeMs: number): boolean {
    const previous = this.lastTap;
    if (!previous) return false;
    return (
      timeMs - previous.time <= this.config.doubleTapMs &&
      Math.hypot(x - previous.at.x, y - previous.at.y) <= this.config.doubleTapRadiusPx
    );
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
    if (this.peak < 2 || this.holding) {
      this.handlers.move(dx, dy, elapsed);
      return;
    }
    // O eixo que dominou o começo da rolagem vale até os dedos saírem: o outro eixo não se mexe (sem deriva na diagonal).
    if (this.config.lockScrollAxis) {
      this.axis ??= Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
      if (this.axis === 'y') dx = 0;
      else dy = 0;
    }
    this.samples.push({ at: timeMs, dx, dy });
    this.handlers.scroll(dx, dy, elapsed);
  }

  /** Os dedos saíram depois de rolar: se ainda iam rápidos, diz a velocidade para quem quiser continuar a rolagem. */
  private endScroll(timeMs: number): void {
    const span = this.config.velocityWindowMs;
    const recent = this.samples.filter((sample) => sample.at >= timeMs - span);
    this.samples = [];
    const newest = recent.at(-1);
    if (!newest || timeMs - newest.at > FLING_FRESH_MS) return;
    const vx = recent.reduce((sum, sample) => sum + sample.dx, 0) / span;
    const vy = recent.reduce((sum, sample) => sum + sample.dy, 0) / span;
    this.handlers.scrollEnd?.(vx, vy);
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
