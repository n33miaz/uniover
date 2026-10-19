export type PadDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export interface GestureConfig {
  /** Deslocamento mínimo (px) a partir de onde o dedo pousou para valer como uma seta. */
  readonly stepPx: number;
  /** Um toque só vale como OK se o dedo ficar menos que isto na tela (ms)... */
  readonly tapMaxMs: number;
  /** ...e se andar menos que isto (px). Os dois limites evitam apertar OK sem querer. */
  readonly tapMaxPx: number;
}

export const DEFAULT_GESTURE: GestureConfig = { stepPx: 24, tapMaxMs: 200, tapMaxPx: 10 };

/**
 * Leitura de um dedo no touchpad, sem tocar no DOM (para testar com números). O dedo funciona como uma alavanca:
 * ao passar do limite em relação ao ponto onde pousou, vira uma seta (a do eixo que andou mais); se continua
 * deslocado, a seta continua valendo e quem usa a repete; voltar para dentro do limite solta a seta.
 */
export class TouchGesture {
  private originX = 0;
  private originY = 0;
  private startedAt = 0;
  private maxDistance = 0;
  private engaged: PadDirection | null = null;
  private everEngaged = false;
  private down = false;

  constructor(private readonly config: GestureConfig = DEFAULT_GESTURE) {}

  /** A seta que está valendo agora (para a repetição enquanto o dedo fica deslocado). */
  get held(): PadDirection | null {
    return this.engaged;
  }

  start(x: number, y: number, timeMs: number): void {
    this.originX = x;
    this.originY = y;
    this.startedAt = timeMs;
    this.maxDistance = 0;
    this.engaged = null;
    this.everEngaged = false;
    this.down = true;
  }

  /** Devolve a seta que acabou de passar a valer (primeira vez ou troca de direção); `null` se nada mudou. */
  move(x: number, y: number): PadDirection | null {
    if (!this.down) return null;
    const dx = x - this.originX;
    const dy = y - this.originY;
    this.maxDistance = Math.max(this.maxDistance, Math.hypot(dx, dy));

    if (Math.max(Math.abs(dx), Math.abs(dy)) < this.config.stepPx) {
      this.engaged = null;
      return null;
    }
    const direction: PadDirection =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'RIGHT' : 'LEFT') : dy > 0 ? 'DOWN' : 'UP';
    if (direction === this.engaged) return null;
    this.engaged = direction;
    this.everEngaged = true;
    return direction;
  }

  /** Termina o gesto; `true` quando foi um toque curto e parado (vira OK). */
  end(timeMs: number): boolean {
    if (!this.down) return false;
    this.down = false;
    const held = this.engaged;
    this.engaged = null;
    return (
      held === null &&
      !this.everEngaged &&
      timeMs - this.startedAt < this.config.tapMaxMs &&
      this.maxDistance < this.config.tapMaxPx
    );
  }

  cancel(): void {
    this.down = false;
    this.engaged = null;
  }
}
