/** De quanto em quanto tempo o dedo parado manda um lote de repetições. */
export const BATCH_EVERY_MS = 120;
/** Quantas repetições por segundo o dedo parado pede (abaixo das 30 do Windows: o PC nunca fica correndo atrás do dedo). */
export const BATCH_RATE_PER_SECOND = 24;
/**
 * O maior lote de um pedido. Quem usa os lotes só manda um quando nada está em voo (a tela passa `busy` = "há algum pedido de
 * tecla pendente"), então depois de o dedo sair o PC ainda executa, no máximo, um lote: no pior caso `BATCH_MAX` apagadas.
 */
export const BATCH_MAX = 8;

/**
 * Repetição de uma tecla segurada em lotes: em vez de um pedido por repetição, a cada `BATCH_EVERY_MS` sai um pedido só com
 * as repetições devidas até agora. A conta é por rodada (não por relógio): cada rodada soma `rate * everyMs / 1000`, com a
 * fração guardada para a seguinte, então o ritmo médio é o pedido e nada depende de o tempo do navegador ser exato.
 *
 * Com a fila cheia (`busy`) a rodada não envia e **acumula** o que é devido, até `max`: assim a primeira rodada livre manda
 * um lote maior, e ao soltar o dedo o que o PC ainda executa nunca passa de um lote. `stop()` joga fora o que era devido.
 */
export class RepeatBatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private owed = 0;

  constructor(
    private readonly send: (count: number) => void,
    private readonly busy: () => boolean = () => false,
    private readonly everyMs: number = BATCH_EVERY_MS,
    private readonly perSecond: number = BATCH_RATE_PER_SECOND,
    private readonly max: number = BATCH_MAX,
  ) {}

  get active(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.round(), this.everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.owed = 0;
  }

  private round(): void {
    this.owed = Math.min(this.max, this.owed + (this.perSecond * this.everyMs) / 1000);
    if (this.owed < 1 || this.busy()) return;
    const count = Math.min(this.max, Math.floor(this.owed));
    this.owed -= count;
    this.send(count);
  }
}
