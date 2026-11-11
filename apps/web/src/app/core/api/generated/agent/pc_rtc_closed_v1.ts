/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcRtcClosedV1BodyReason =
  | 'requested'
  | 'connect_timeout'
  | 'idle'
  | 'failed'
  | 'replaced'
  | 'shutdown'
  | 'disconnected'
  | 'lifetime'
  | 'revoked'
  | 'cloud'
  | 'rescoped';

/**
 * Agente para API: o canal direto da sessão fechou, com o motivo (a API grava a trilha). `tvKeys` e `tvTexts` (opcionais, só de um canal com o escopo `tv`) contam as teclas e os textos da TV que o canal levou, para a trilha da TV: nenhuma tecla vai uma a uma ao registro, e esta soma é o que a API grava no lugar. Só vão a quem declara tv.rtc.v1. Sem resposta.
 */
export interface PcRtcClosedV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.closed.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcClosedV1Body;
}
export interface PcRtcClosedV1Body {
  sessionId: string;
  reason: PcRtcClosedV1BodyReason;
  tvKeys?: number;
  tvTexts?: number;
}
