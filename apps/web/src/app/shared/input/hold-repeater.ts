/**
 * Repete uma ação enquanto o dedo segura o botão: a primeira repetição vem depois de `delayMs` e as seguintes a
 * cada `intervalMs`. A primeira ação (no toque) é de quem usa; aqui só entra o "segurar". `shouldSkip` deixa uma
 * rodada passar sem agir (por exemplo quando há comandos demais sem resposta), sem parar a repetição.
 *
 * A repetição para sozinha quando a página vai para o segundo plano (`visibilitychange` oculto ou `pagehide`): o sistema pode
 * suspender a página sem entregar o "soltou" do dedo, e a repetição que sobrevivesse voltaria a disparar tecla sozinha ao
 * voltar ao app, com a conexão já derrubada, falhando e mostrando um aviso que ninguém provocou.
 */
export class HoldRepeater {
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private watching = false;

  constructor(
    private readonly action: () => void,
    private readonly delayMs: number,
    private readonly intervalMs: number,
    private readonly shouldSkip: () => boolean = () => false,
  ) {}

  /** A página saiu da tela: nenhuma repetição segue. */
  private readonly onHide = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') this.stop();
  };
  private readonly onPageHide = () => this.stop();

  get active(): boolean {
    return this.delayTimer !== undefined || this.intervalTimer !== undefined;
  }

  start(): void {
    this.stop();
    this.watch(true);
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
    this.watch(false);
  }

  private tick(): void {
    if (!this.shouldSkip()) this.action();
  }

  /** Só escuta a página enquanto há repetição: um botão parado não deixa ouvinte nenhum para trás. */
  private watch(on: boolean): void {
    if (typeof document === 'undefined' || this.watching === on) return;
    this.watching = on;
    const win = document.defaultView;
    if (on) {
      document.addEventListener('visibilitychange', this.onHide);
      win?.addEventListener('pagehide', this.onPageHide);
    } else {
      document.removeEventListener('visibilitychange', this.onHide);
      win?.removeEventListener('pagehide', this.onPageHide);
    }
  }
}
