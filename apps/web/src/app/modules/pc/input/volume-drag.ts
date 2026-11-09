/**
 * Quantos pixels de arrasto valem um passo do volume. O Windows move o volume de 2 em 2: sobre a faixa de cerca de 200 px de
 * um iPhone, deslizar de ponta a ponta dá uns 30 passos (60%), e dois arrastos cobrem a escala.
 */
export const PX_PER_VOLUME_STEP = 7;

/** O contrato (`pc.media.v1`) aceita de 1 a 10 passos por pedido. */
export const MAX_STEPS_PER_REQUEST = 10;

/** O que ainda esperava para sair (a rede lenta) nunca passa disto: não se corre atrás do dedo por mais que uma escala inteira. */
export const MAX_PENDING_STEPS = 50;

export type VolumeDirection = 'UP' | 'DOWN';

export interface VolumeRequest {
  readonly direction: VolumeDirection;
  readonly steps: number;
}

/**
 * Volume relativo: o arrasto horizontal vira passos de volume, sem nunca dizer em que nível o PC está (o nível absoluto é
 * outra mensagem, que não existe). É uma conta de deslocamento: o que o dedo andou, e não onde ele está. Os passos que ainda
 * não saíram (um pedido em voo) se somam com sinal, então ir e voltar antes de sair não manda nada. Pura: quem usa decide
 * quando perguntar `take`.
 */
export class VolumeDrag {
  private pixels = 0;
  private pending = 0;

  /** O dedo andou `dx` pixels (positivo, para a direita, sobe o volume). */
  move(dx: number): void {
    if (!Number.isFinite(dx)) return;
    this.pixels += dx;
    const whole = Math.trunc(this.pixels / PX_PER_VOLUME_STEP);
    if (whole === 0) return;
    this.pixels -= whole * PX_PER_VOLUME_STEP;
    this.pending = Math.max(-MAX_PENDING_STEPS, Math.min(MAX_PENDING_STEPS, this.pending + whole));
  }

  /** Há passos esperando para sair. */
  get waiting(): boolean {
    return this.pending !== 0;
  }

  /** O próximo pedido (no máximo `MAX_STEPS_PER_REQUEST` passos, de um só sentido), ou `null` se nada espera. */
  take(): VolumeRequest | null {
    if (this.pending === 0) return null;
    const direction: VolumeDirection = this.pending > 0 ? 'UP' : 'DOWN';
    const steps = Math.min(MAX_STEPS_PER_REQUEST, Math.abs(this.pending));
    this.pending -= direction === 'UP' ? steps : -steps;
    return { direction, steps };
  }

  /** Esquece o que esperava (um pedido falhou, ou o dedo recomeça): a fração de pixel também. */
  reset(): void {
    this.pixels = 0;
    this.pending = 0;
  }
}
