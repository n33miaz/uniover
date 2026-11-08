/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: um candidato ICE que o app descobriu depois da oferta (reservado: o app espera a coleta terminar antes de oferecer, então hoje quase não é usado). O agente descarta candidatos .local.
 */
export interface PcRtcCandidateV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.candidate.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcCandidateV1Body;
}
export interface PcRtcCandidateV1Body {
  sessionId: string;
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}
