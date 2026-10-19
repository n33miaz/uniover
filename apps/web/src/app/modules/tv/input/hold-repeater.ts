/**
 * Repete uma ação enquanto o dedo segura o botão: a primeira repetição vem depois de `delayMs` e as seguintes a
 * cada `intervalMs`. A primeira ação (no toque) é de quem usa; aqui só entra o "segurar". `shouldSkip` deixa uma
 * rodada passar sem agir (por exemplo quando há comandos demais sem resposta), sem parar a repetição.
 */
export class HoldRepeater {
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly action: () => void,
    private readonly delayMs: number,
    private readonly intervalMs: number,
    private readonly shouldSkip: () => boolean = () => false,
  ) {}

  get active(): boolean {
    return this.delayTimer !== undefined || this.intervalTimer !== undefined;
  }

  start(): void {
    this.stop();
    this.delayTimer = setTimeout(() => {
      this.delayTimer = undefined;
      this.tick();
      this.intervalTimer = setInterval(() => this.tick(), this.intervalMs);
    }, this.delayMs);
  }

  stop(): void {
    clearTimeout(this.delayTimer);
    clearInterval(this.intervalTimer);
    this.delayTimer = undefined;
    this.intervalTimer = undefined;
  }

  private tick(): void {
    if (!this.shouldSkip()) this.action();
  }
}
