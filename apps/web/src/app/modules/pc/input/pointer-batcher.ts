export interface PointerBatch {
  readonly dx: number;
  readonly dy: number;
  readonly scrollX: number;
  readonly scrollY: number;
  /**
   * Número do pedido, crescente durante a vida do `PointerBatcher` (nunca volta a zero nem se repete). Com vários
   * pedidos em voo ao mesmo tempo, o agente usa isto só para diagnóstico (reconhecer o que chega fora de ordem e uma
   * sessão nova); o movimento é relativo e todos os pedidos são aplicados.
   */
  readonly seq: number;
}

export interface BatcherOptions {
  /** Intervalo mínimo entre o começo de um pedido e o do seguinte (limita a taxa; ~30 pedidos por segundo). */
  readonly minIntervalMs: number;
  /**
   * Quantos pedidos de movimento podem estar em voo ao mesmo tempo. A taxa máxima é `maxInFlight` por tempo de ida e
   * volta (6 em 200 ms são 30 por segundo; em 490 ms, uns 12): o que passar disto se soma no pedido seguinte.
   */
  readonly maxInFlight: number;
  /** Maior valor somado num pedido: o que passar disto fica para o próximo (o contrato do agente tem teto). */
  readonly maxMove: number;
  readonly maxScroll: number;
}

export const DEFAULT_BATCHER: BatcherOptions = {
  minIntervalMs: 32,
  maxInFlight: 8,
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
 * Junta o movimento do dedo em poucos pedidos e os manda em fila contínua: vários pedidos em voo ao mesmo tempo (até
 * `maxInFlight`), um a cada `minIntervalMs`, sem esperar a resposta do anterior. A taxa deixa de ser 1 por tempo de ida
 * e volta da rede (com uns 200 a 500 ms de ida e volta até a API, isso eram 2 a 5 por segundo) e passa a ser a do
 * relógio (uns 30 por segundo). Cada pedido leva um `seq` crescente: os pedidos paralelos podem chegar trocados na API,
 * e como o movimento é relativo (a soma não depende da ordem) o agente aplica todos, só contando o que veio fora de
 * ordem. Se a rede
 * enche o limite de voo, o que o dedo andou se soma e vai tudo junto na primeira vaga (a taxa se adapta sozinha à
 * latência). Falha de um pedido descarta o que estava esperando (um ponteiro atrasado é pior que nenhum).
 */
export class PointerBatcher {
  private pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
  private readonly inFlight = new Set<Promise<void>>();
  private seq = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private stopped = false;
  private held = false;

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

  /**
   * Segura o que o dedo andou: some no que espera, mas nada sai até `resume()`. É o que a pressão longa usa enquanto o
   * aperto do botão ainda não terminou (o ponteiro só anda depois que o botão está apertado). `drain()` continua mandando.
   */
  hold(): void {
    this.held = true;
    this.cancelTimer();
  }

  /** Solta o que foi segurado: o que se acumulou sai assim que a taxa permite. */
  resume(): void {
    this.held = false;
    if (this.hasPending()) this.schedule();
  }

  /** Há algo esperando ou em voo? */
  get busy(): boolean {
    return this.inFlight.size > 0 || this.hasPending();
  }

  /**
   * Manda já o que está esperando, sem esperar a taxa nem uma vaga, e NÃO espera a resposta. É o que o clique e o aperto do
   * botão usam: saem logo atrás do último movimento (os pedidos partem na ordem em que foram feitos, e o agente executa
   * na ordem em que chegam) sem somar a ida e volta da rede ao clique.
   */
  flush(): void {
    this.cancelTimer();
    while (this.hasPending() && !this.stopped) this.dispatch();
    if (this.stopped) this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
  }

  /**
   * Manda já o que está esperando e devolve quando tudo chegou ao servidor (todas as respostas). Para quem precisa saber
   * que o movimento foi entregue, não só enviado.
   */
  async drain(): Promise<void> {
    this.cancelTimer();
    while (this.inFlight.size > 0 || this.hasPending()) {
      if (this.hasPending()) {
        if (this.stopped) this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
        else this.dispatch();
      } else {
        await Promise.all([...this.inFlight]);
      }
    }
  }

  /**
   * Esquece o que esperava (movimento somado e o aguardo da taxa) e continua utilizável. É o que a troca de conta usa:
   * movimento pendente de uma pessoa nunca sai depois como se fosse de outra. Não espera nada ("esvaziar" mandaria o
   * movimento antigo). Os pedidos que já estão em voo seguem, mas o que eles deixarem para trás também é descartado.
   */
  discard(): void {
    this.cancelTimer();
    this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
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
    if (
      this.stopped ||
      this.held ||
      this.inFlight.size >= this.options.maxInFlight ||
      this.timer !== null
    )
      return;
    const wait = Math.max(0, this.lastSentAt + this.options.minIntervalMs - this.clock.now());
    if (wait === 0) {
      this.dispatch();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.inFlight.size < this.options.maxInFlight && !this.held) this.dispatch();
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
      seq: ++this.seq,
    };
    // O que passou do teto de um pedido fica para o seguinte.
    this.pending = {
      dx: this.pending.dx - batch.dx,
      dy: this.pending.dy - batch.dy,
      scrollX: this.pending.scrollX - batch.scrollX,
      scrollY: this.pending.scrollY - batch.scrollY,
    };
    this.lastSentAt = this.clock.now();
    const flight: Promise<void> = this.send(batch)
      .then((ok) => {
        if (!ok) this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
      })
      .catch(() => {
        this.pending = { dx: 0, dy: 0, scrollX: 0, scrollY: 0 };
      })
      .finally(() => {
        this.inFlight.delete(flight);
        // O que se acumulou com o limite de voo cheio sai assim que a taxa permite.
        if (this.hasPending() && !this.held) this.schedule();
      });
    this.inFlight.add(flight);
  }
}
