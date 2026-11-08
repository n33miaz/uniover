/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcRtcCloseV1BodyReason =
  'requested' | 'connect_timeout' | 'idle' | 'failed' | 'replaced' | 'shutdown' | 'disconnected';

/**
 * API para agente: o app (ou a API) fecha o canal direto da sessão; o agente solta o que o PC ficou segurando e não responde. O agente avisa o próprio fechamento com pc.rtc.closed.v1.
 */
export interface PcRtcCloseV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.close.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcCloseV1Body;
}
export interface PcRtcCloseV1Body {
  sessionId: string;
  reason?: PcRtcCloseV1BodyReason;
}
