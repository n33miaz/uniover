/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcTextV3BodyKey = 'ENTER' | 'TAB';
export type PcTextV3BodyTarget = 'browser' | 'spotify' | 'vlc';

/**
 * API para agente: igual à `pc.text.v2` (apagar `erase` caracteres, digitar `text` e apertar `key`, nesta ordem e no mesmo toque no sistema), mas `text` pode levar quebra de linha (LF) e tabulação: é o texto colado com várias linhas, que chega inteiro num pedido em vez de um pedido por linha. O agente digita cada caractere em ordem e aperta Enter na quebra de linha e Tab na tabulação, cada aperto com a sua soltura no mesmo lote, então nenhuma tecla fica apertada entre um pedido e outro. CR e os demais caracteres de controle continuam proibidos (o app troca CRLF e CR por LF). `text` tem 1 a 200 caracteres. A API só a usa quando o texto tem LF ou Tab e só para o agente que declarou a capacidade `pc.text.v3`; para os demais o app manda as quebras como `key` da `pc.text.v2`, como sempre. `seq`, `epoch` e `target` como na `pc.text.v2`.
 */
export interface PcTextV3Message {
  v: 1;
  id: string;
  type: 'pc.text.v3';
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
  body: PcTextV3Body;
}
export interface PcTextV3Body {
  erase?: number;
  text?: string;
  key?: PcTextV3BodyKey;
  seq?: number;
  epoch?: string;
  target?: PcTextV3BodyTarget;
}
