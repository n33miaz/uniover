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
  | 'cloud';

/**
 * Agente para API: o canal direto da sessão fechou, com o motivo (a API grava a trilha). Sem resposta.
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
}
