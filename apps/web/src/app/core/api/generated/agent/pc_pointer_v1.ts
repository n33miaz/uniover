/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: movimento do mouse e rolagem já somados pelo app (vários toques do dedo viram uma mensagem). `dx`/`dy` são pixels relativos (positivo: direita e baixo); `scrollX`/`scrollY` estão em unidades de roda (120 = um clique da roda) e têm o sinal do Windows (positivo: direita e cima). O agente limita cada valor e executa sem responder (a API manda o movimento sem esperar resposta). `seq` é opcional e só serve ao diagnóstico: o app numera os pedidos de movimento em ordem crescente durante a vida da página e manda vários ao mesmo tempo, então o agente reconhece o que chega fora de ordem (e uma sessão nova, quando o contador recomeça). O movimento é relativo e a soma não depende da ordem: o agente aplica também o que chega depois de um mais novo; só a idade descarta um movimento.
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
  seq?: number;
}
