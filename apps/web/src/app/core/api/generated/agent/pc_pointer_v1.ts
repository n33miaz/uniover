/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: movimento do mouse e rolagem já somados pelo app (vários toques do dedo viram uma mensagem). `dx`/`dy` são pixels relativos (positivo: direita e baixo); `scrollX`/`scrollY` estão em unidades de roda (120 = um clique da roda) e têm o sinal do Windows (positivo: direita e cima). O agente limita cada valor e executa sem responder (a API manda o movimento sem esperar resposta). `seq` é opcional e só serve ao diagnóstico: o app numera os pedidos de movimento em ordem crescente durante a vida da página e manda vários ao mesmo tempo, então o agente reconhece o que chega fora de ordem (e uma sessão nova, quando o contador recomeça). O movimento é relativo e a soma não depende da ordem: o agente aplica também o que chega depois de um mais novo; só a idade descarta um movimento. A API só o repassa a um agente que declara `pc.rtc.v1` (o esquema dos agentes anteriores é fechado).
 */
export interface PcPointerV1Message {
  v: 1;
  id: string;
  type: 'pc.pointer.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  /**
   * O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.
   */
  deviceId?: string;
  /**
   * O nome do aparelho para a pergunta de aprovação no PC (ver `deviceId`): até 60 caracteres, sem texto de controle.
   */
  deviceName?: string;
  body: PcPointerV1Body;
}
export interface PcPointerV1Body {
  dx: number;
  dy: number;
  scrollX?: number;
  scrollY?: number;
  seq?: number;
}
