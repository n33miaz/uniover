/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcRtcOfferV1BodyScopesItem = 'pc' | 'tv';

/**
 * API para agente: o app quer abrir o canal direto (WebRTC) com este PC. Leva a oferta SDP do app e o token de uso único e `tokenTtlSeconds` (a vida dele, contada pelo agente a partir do recebimento) e `maxLifetimeSeconds` (o teto da vida do canal inteiro, que a API tira do que resta do token de acesso da pessoa: o canal nunca vive mais que a sessão que o autorizou; o app abre outro antes do fim), que a primeira mensagem do canal precisa apresentar. O agente responde com pc.rtc.answer.v1 (mesmo correlationId) e command.result.v1. `scopes` (opcional) diz o que o canal pode levar: `pc` (mouse, teclado, mídia, zoom e volume do PC; exige o aparelho aprovado no PC) e/ou `tv` (as teclas e o texto da TV que este agente controla, pelo mesmo caminho dos comandos tv.* da nuvem; nunca o desligamento, abrir app nem limpeza). Sem `scopes` o canal é só do PC, como sempre foi. Quem decide os escopos é a API, que os confere para a pessoa e para a TV no momento da oferta; o agente só os aplica. `scopes` só vai a quem declara a capacidade tv.rtc.v1. Só vai a quem declara a capacidade pc.rtc.v1.
 */
export interface PcRtcOfferV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.offer.v1';
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
  body: PcRtcOfferV1Body;
}
export interface PcRtcOfferV1Body {
  sessionId: string;
  sdp: string;
  token: string;
  tokenTtlSeconds: number;
  maxLifetimeSeconds: number;
  /**
   * @minItems 1
   * @maxItems 2
   */
  scopes?: [PcRtcOfferV1BodyScopesItem] | [PcRtcOfferV1BodyScopesItem, PcRtcOfferV1BodyScopesItem];
}
