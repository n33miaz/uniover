/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcClickV1BodyButton = 'LEFT' | 'RIGHT' | 'MIDDLE';
export type PcClickV1BodyAction = 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP';

/**
 * API para agente: clique do mouse. `down` e `up` existem para arrastar (toque e segure); sem `action` vale `click`. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`.
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
  seq?: number;
}
