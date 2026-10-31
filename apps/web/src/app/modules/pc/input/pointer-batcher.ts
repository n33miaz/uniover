export interface PointerBatch {
  readonly dx: number;
  readonly dy: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface BatcherOptions {
  /** Intervalo mínimo entre o começo de um pedido e o do seguinte (limita a taxa; ~30 pedidos por segundo). */
  readonly minIntervalMs: number;
  /** Maior valor somado num pedido: o que passar disto fica para o próximo (o contrato do agente tem teto). */
  readonly maxMove: number;
  readonly maxScroll: number;
}

export const DEFAULT_BATCHER: BatcherOptions = {
  minIntervalMs: 32,
  maxMove: 2000,
  maxScroll: 1200,
};

interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: Clock = {
  now: () => performance.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/**
 * Junta o movimento do dedo em poucos pedidos. Há no máximo UM pedido de movimento em voo: enquanto ele espera a
 * resposta, o que o dedo andou se soma, e vai tudo junto no pedido seguinte. Isso dá três coisas de uma vez: a ordem
 * dos movimentos nunca se troca, a taxa se adapta sozinha à latência da rede (rede lenta, pedidos maiores e mais
 * espaçados; rede rápida, pedidos pequenos e frequentes) e o servidor nunca recebe mais que `1000 / minIntervalMs` por
 * segundo. Falha de um pedido descarta o que estava esperando (um ponteiro atrasado é pior que nenhum).
 */
export class PointerBatcher {
  private pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
  private inFlight: Promise<void> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private stopped = false;

  constructor(
    private readonly send: (batch: PointerBatch) => Promise<boolean>,
    private readonly options: BatcherOptions = DEFAULT_BATCHER,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** Acrescenta movimento do ponteiro (já inteiro, depois da aceleração). */
  addMove(dx: number, dy: number): void {
    this.pending.dx += dx;
    this.pending.dy += dy;
    this.schedule();
  }

  addScroll(scrollX: number, scrollY: number): void {
    this.pending.scrollX += scrollX;
    this.pending.scrollY += scrollY;
    this.schedule();
  }

  /** Há algo esperando ou em voo? */
  get busy(): boolean {
    return this.inFlight !== null || this.hasPending();
  }

  /**
   * Manda já o que está esperando e devolve quando tudo chegou ao servidor. O clique usa isto para nunca passar na frente
   * de um movimento que o dedo fez antes dele.
   */
  async drain(): Promise<void> {
    this.cancelTimer();
    while (this.inFlight || this.hasPending()) {
      if (this.inFlight) await this.inFlight;
      else if (!this.stopped) this.dispatch();
      else this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
    }
  }

  /** Encerra: o que esperava é descartado e nada mais sai. */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
    this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
  }

  private hasPending(): boolean {
    const { dx, dy, scrollX, scrollY } = this.pending;
    return dx !== 0 || dy !== 0 || scrollX !== 0 || scrollY !== 0;
  }

  private schedule(): void {
    if (this.stopped || this.inFlight || this.timer !== null) return;
    const wait = Math.max(0, this.lastSentAt + this.options.minIntervalMs - this.clock.now());
    if (wait === 0) {
      this.dispatch();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.inFlight) this.dispatch();
    }, wait);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private dispatch(): void {
    if (!this.hasPending()) return;
    const { maxMove, maxScroll } = this.options;
    const batch: PointerBatch = {
      dx: clamp(this.pending.dx, maxMove),
      dy: clamp(this.pending.dy, maxMove),
      scrollX: clamp(this.pending.scrollX, maxScroll),
      scrollY: clamp(this.pending.scrollY, maxScroll),
    };
    // O que passou do teto de um pedido fica para o seguinte.
    this.pending = {
      dx: this.pending.dx - batch.dx,
      dy: this.pending.dy - batch.dy,
      scrollX: this.pending.scrollX - batch.scrollX,
      scrollY: this.pending.scrollY - batch.scrollY,
    };
    this.lastSentAt = this.clock.now();
    this.inFlight = this.send(batch)
      .then((ok) => {
        if (!ok) this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
      })
      .catch(() => {
        this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
      })
      .finally(() => {
        this.inFlight = null;
        // O que se acumulou durante o voo sai assim que a taxa permite.
        if (this.hasPending()) this.schedule();
      });
  }
}
