/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcPowerV1BodyAction = 'LOCK' | 'SLEEP' | 'SHUTDOWN' | 'CANCEL_SHUTDOWN';

/**
 * API para agente: energia do PC. `LOCK` bloqueia a sessão; `SLEEP` suspende; `SHUTDOWN` agenda o desligamento com a contagem do Windows (aviso na tela do PC) e `CANCEL_SHUTDOWN` cancela essa contagem. Quem confirma com a pessoa é o app e a API; o agente não repete nem adia nada.
 */
export interface PcPowerV1Message {
  v: 1;
  id: string;
  type: 'pc.power.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  /**
   * Identificador da operação (opcional): o mesmo do pedido HTTP que originou o comando do PC (`X-Operation-Id`), para ligar o registro da API ao do agente. Só aparece em comandos `pc.*` que NÃO são o movimento do mouse e só vai a um agente que declarou a capacidade `pc.op.v1` (o esquema de um agente anterior é fechado e recusaria a mensagem inteira). Nunca leva texto, teclas nem coordenadas: é só um código.
   */
  operationId?: string;
  /**
   * O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.
   */
  deviceId?: string;
  /**
   * O nome do aparelho para a pergunta de aprovação no PC (ver `deviceId`): até 60 caracteres, sem texto de controle.
   */
  deviceName?: string;
  body: PcPowerV1Body;
}
export interface PcPowerV1Body {
  action: PcPowerV1BodyAction;
}
