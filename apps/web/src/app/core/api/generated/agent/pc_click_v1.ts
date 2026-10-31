/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcClickV1BodyButton = 'LEFT' | 'RIGHT' | 'MIDDLE';
export type PcClickV1BodyAction = 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP';

/**
 * API para agente: clique do mouse. `down` e `up` existem para arrastar (toque e segure); sem `action` vale `click`.
 */
export interface PcClickV1Message {
  v: 1;
  id: string;
  type: 'pc.click.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcClickV1Body;
}
export interface PcClickV1Body {
  button: PcClickV1BodyButton;
  action?: PcClickV1BodyAction;
}
