/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcDeviceStateV1BodyState = 'pending' | 'denied' | 'approved';

/**
 * Agente para API: a decisão do dono do PC sobre um aparelho do app (`deviceId`, o mesmo que a API mandou no envelope): `pending` (a pergunta está aberta no PC), `denied` (o dono recusou) ou `approved` (permitiu). A API guarda `pending` e `denied` em memória, por agente e aparelho, com validade curta, e responde 403 `pc-device-pending` ou `pc-device-denied` também ao movimento do mouse (que o agente descarta sem resposta) enquanto valer; `approved` limpa. O agente o manda quando a decisão muda e, enquanto o aparelho continua mandando comando recusado, no máximo a cada 10 s (renova a validade). Só vai a uma API que listou `pc.device.v1` em `features` (uma anterior recusaria o tipo). Sem resposta.
 */
export interface PcDeviceStateV1Message {
  v: 1;
  id: string;
  type: 'pc.device.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcDeviceStateV1Body;
}
export interface PcDeviceStateV1Body {
  /**
   * O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.
   */
  deviceId: string;
  state: PcDeviceStateV1BodyState;
  at: string;
}
