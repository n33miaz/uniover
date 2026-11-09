/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: o app quer abrir o canal direto (WebRTC) com este PC. Leva a oferta SDP do app e o token de uso único e `tokenTtlSeconds` (a vida dele, contada pelo agente a partir do recebimento) e `maxLifetimeSeconds` (o teto da vida do canal inteiro, que a API tira do que resta do token de acesso da pessoa: o canal nunca vive mais que a sessão que o autorizou; o app abre outro antes do fim), que a primeira mensagem do canal precisa apresentar. O agente responde com pc.rtc.answer.v1 (mesmo correlationId) e command.result.v1. Só vai a quem declara a capacidade pc.rtc.v1.
 */
export interface PcRtcOfferV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.offer.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcOfferV1Body;
}
export interface PcRtcOfferV1Body {
  sessionId: string;
  sdp: string;
  token: string;
  tokenTtlSeconds: number;
  maxLifetimeSeconds: number;
}
