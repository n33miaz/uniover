/** Velocidade da rolagem em pixels do dedo por milissegundo. */
export interface ScrollVelocity {
  readonly vx: number;
  readonly vy: number;
}

/** Abaixo desta velocidade (px/ms) os dedos saíram devagar demais: a rolagem para onde o dedo parou. */
export const INERTIA_MIN_SPEED = 0.4;
/** Abaixo desta velocidade (px/ms) a rolagem que seguia sozinha acaba. */
export const INERTIA_STOP_SPEED = 0.04;
/** O tempo (ms) em que a velocidade cai a 1/e: quanto maior, mais longe a rolagem desliza. */
export const INERTIA_TIME_CONSTANT_MS = 260;
/**
 * O toque que para a rolagem que seguia sozinha só é engolido (não clica) enquanto a rolagem ainda é visível: acima desta
 * velocidade (px/ms) ou nos primeiros `INERTIA_SWALLOW_MS` do gesto. Depois disso a página já parou aos olhos da pessoa, e
 * um toque ali é um toque comum.
 */
export const INERTIA_SWALLOW_SPEED = 0.3;
export const INERTIA_SWALLOW_MS = 400;

/** Teto da velocidade com que a rolagem parte (um gesto muito brusco não vira uma rolagem sem fim). */
export const INERTIA_MAX_SPEED = 4;

const speedOf = (velocity: ScrollVelocity) => Math.hypot(velocity.vx, velocity.vy);

/** A velocidade com que a rolagem segue depois que os dedos saíram, ou `null` se foi devagar demais para valer a pena. */
export function inertiaStart(vx: number, vy: number): ScrollVelocity | null {
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed < INERTIA_MIN_SPEED) return null;
  const scale = speed > INERTIA_MAX_SPEED ? INERTIA_MAX_SPEED / speed : 1;
  return { vx: vx * scale, vy: vy * scale };
}

/**
 * Um passo da rolagem que desacelera sozinha (atrito proporcional à velocidade): quanto andou em `dtMs` e a velocidade que
 * sobra, ou `null` quando acabou. Função pura: o tempo vem de fora.
 */
export function inertiaStep(
  velocity: ScrollVelocity,
  dtMs: number,
): { dx: number; dy: number; next: ScrollVelocity | null } {
  const decay = Math.exp(-dtMs / INERTIA_TIME_CONSTANT_MS);
  // O que anda num passo é a integral da velocidade que decai (e não a velocidade do começo vezes o tempo).
  const reach = INERTIA_TIME_CONSTANT_MS * (1 - decay);
  const next = { vx: velocity.vx * decay, vy: velocity.vy * decay };
  return {
    dx: velocity.vx * reach,
    dy: velocity.vy * reach,
    next: speedOf(next) < INERTIA_STOP_SPEED ? null : next,
  };
}

/** Quem agenda os quadros (troca-se nos testes). */
export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export interface InertiaDeps {
  readonly frames: FrameScheduler;
  /** Cada passo de rolagem: pixels do dedo e o tempo do passo (a aceleração e o sentido são de quem recebe). */
  readonly scroll: (dx: number, dy: number, dtMs: number) => void;
  /** Devolve `false` quando não se pode mais mandar nada ao PC (sem conexão, aba escondida): a rolagem para. */
  readonly canRun: () => boolean;
  /** Quem pediu para reduzir o movimento não recebe rolagem que segue sozinha. */
  readonly reducedMotion: () => boolean;
  /** O relógio em milissegundos (o mesmo dos quadros); troca-se nos testes. */
  readonly now?: () => number;
}

/** O maior passo de tempo de um quadro: um quadro atrasado (aba ocupada) não vira um salto de rolagem. */
const MAX_FRAME_MS = 50;

/**
 * A rolagem que segue depois dos dedos saírem e desacelera até parar. Manda a mesma rolagem que o dedo mandaria. Para
 * sozinha quando acaba e para na hora com `stop()`: um toque novo, a página escondida, a tela fechada, a conta trocada ou o
 * PC que sumiu. Não existe com "reduzir movimento".
 */
export class ScrollInertia {
  private velocity: ScrollVelocity | null = null;
  private handle: number | null = null;
  private lastTime: number | null = null;
  private startedAt = 0;

  constructor(private readonly deps: InertiaDeps) {}

  get active(): boolean {
    return this.velocity !== null;
  }

  /** A velocidade de agora em px/ms (0 parada). */
  get speed(): number {
    return this.velocity ? speedOf(this.velocity) : 0;
  }

  /** Há quanto tempo a rolagem segue sozinha, em ms (0 parada). */
  get age(): number {
    return this.velocity ? this.now() - this.startedAt : 0;
  }

  /** Um toque agora pararia uma rolagem que a pessoa ainda vê andar: esse toque é só "pare", não um clique. */
  get visible(): boolean {
    return this.active && (this.speed >= INERTIA_SWALLOW_SPEED || this.age < INERTIA_SWALLOW_MS);
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  /** Começa a seguir com a velocidade dos dedos ao sair (px/ms). Sem velocidade que valha, ou sem permissão, não faz nada. */
  start(vx: number, vy: number): void {
    this.stop();
    if (this.deps.reducedMotion() || !this.deps.canRun()) return;
    const velocity = inertiaStart(vx, vy);
    if (!velocity) return;
    this.velocity = velocity;
    this.startedAt = this.now();
    this.schedule();
  }

  stop(): void {
    if (this.handle !== null) this.deps.frames.cancel(this.handle);
    this.handle = null;
    this.velocity = null;
    this.lastTime = null;
  }

  private schedule(): void {
    this.handle = this.deps.frames.request((time) => this.frame(time));
  }

  private frame(time: number): void {
    this.handle = null;
    const velocity = this.velocity;
    if (!velocity) return;
    if (!this.deps.canRun()) {
      this.stop();
      return;
    }
    const previous = this.lastTime ?? time - 16;
    this.lastTime = time;
    const dt = Math.min(MAX_FRAME_MS, Math.max(1, time - previous));
    const step = inertiaStep(velocity, dt);
    this.deps.scroll(step.dx, step.dy, dt);
    if (step.next === null) {
      this.stop();
      return;
    }
    this.velocity = step.next;
    this.schedule();
  }
}
