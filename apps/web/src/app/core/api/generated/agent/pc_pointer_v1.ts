/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: movimento do mouse e rolagem já somados pelo app (vários toques do dedo viram uma mensagem). `dx`/`dy` são pixels relativos (positivo: direita e baixo); `scrollX`/`scrollY` estão em unidades de roda (120 = um clique da roda) e têm o sinal do Windows (positivo: direita e cima). O agente limita cada valor e executa sem responder (a API manda o movimento sem esperar resposta).
 */
export interface PcPointerV1Message {
  v: 1;
  id: string;
  type: 'pc.pointer.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcPointerV1Body;
}
export interface PcPointerV1Body {
  dx: number;
  dy: number;
  scrollX?: number;
  scrollY?: number;
}
