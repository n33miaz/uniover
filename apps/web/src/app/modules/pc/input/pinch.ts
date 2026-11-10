/**
 * Reconhecimento da pinça (zoom) do touchpad, em funções e classes puras: só números, nada de DOM nem de relógio.
 *
 * Dois dedos fazem duas coisas: rolam (andam juntos, a distância entre eles quase não muda) ou apertam e abrem (a distância
 * muda e o centro quase não anda). A decisão sai uma vez por gesto e fica (como a trava de direção da rolagem): quem decide é
 * `classifyTwoFingers`, e a rolagem leva a vantagem no empate, para a pinça nunca tomar um deslize.
 */

export interface PinchConfig {
  /** Quanto a distância entre os dedos precisa mudar (px) antes de a pinça valer: a folga contra o tremor, como a da rolagem. */
  readonly startPx: number;
  /** A pinça só vence se a mudança de distância for pelo menos isto vezes o quanto o centro dos dedos andou. */
  readonly dominance: number;
  /** Quantos pixels de distância valem um clique de roda (um passo de zoom). */
  readonly pxPerStep: number;
}

export const DEFAULT_PINCH: PinchConfig = {
  startPx: 14,
  dominance: 1.5,
  // Uma pinça de ponta a ponta num iPhone (uns 200 px) dá uns 8 passos: o zoom do navegador vai de 100% a 250%.
  pxPerStep: 24,
};

/** O que os dois dedos estão fazendo, até agora. */
export type TwoFingerIntent = 'undecided' | 'pinch' | 'scroll';

/**
 * Decide o que dois dedos fazem, dado o quanto a distância entre eles mudou desde que pousaram (`spreadChange`, px, com sinal)
 * e o quanto o centro deles andou (`centerTravel`, px, sem sinal). `slopPx` é o raio do tremor da rolagem.
 *
 * - a pinça vale quando a distância mudou pelo menos `startPx` e `dominance` vezes o deslocamento do centro;
 * - senão, a rolagem vale assim que o centro sai do raio do tremor (é o mesmo instante em que a rolagem começava antes);
 * - senão, ainda não se sabe.
 */
export function classifyTwoFingers(
  spreadChange: number,
  centerTravel: number,
  slopPx: number,
  config: PinchConfig = DEFAULT_PINCH,
): TwoFingerIntent {
  const spread = Math.abs(spreadChange);
  if (spread >= config.startPx && spread >= config.dominance * centerTravel) return 'pinch';
  if (centerTravel > slopPx) return 'scroll';
  return 'undecided';
}

/**
 * Converte a mudança da distância entre os dedos em passos de zoom inteiros, guardando a sobra (a fração de passo não se
 * perde entre um movimento e o seguinte). Positivo: os dedos se abriram (aproxima). Pura: quem usa decide quando perguntar.
 */
export class PinchTracker {
  private base = 0;

  constructor(private readonly config: PinchConfig = DEFAULT_PINCH) {}

  /** Os dedos pousaram (ou o conjunto deles mudou): a distância de agora é a referência. */
  begin(spread: number): void {
    this.base = Number.isFinite(spread) ? spread : 0;
  }

  /** Os passos inteiros que a distância de agora acrescenta, com sinal; a sobra fica para a próxima chamada. */
  update(spread: number): number {
    if (!Number.isFinite(spread)) return 0;
    const whole = Math.trunc((spread - this.base) / this.config.pxPerStep);
    if (whole === 0) return 0;
    this.base += whole * this.config.pxPerStep;
    return whole;
  }
}
