/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: a resposta SDP à oferta do canal direto, com a impressão digital DTLS do agente. O correlationId é o id do pc.rtc.offer.v1. A API a entrega ao app pela rota autenticada; nada fica guardado.
 */
export interface PcRtcAnswerV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.answer.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcAnswerV1Body;
}
export interface PcRtcAnswerV1Body {
  sessionId: string;
  sdp: string;
}
