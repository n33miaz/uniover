/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API, logo depois do hello: o canal direto que ficou aberto enquanto a conexão caiu (a API pode ter reiniciado e perdido o registro dele). Leva só `sessionId` e o `ticket` que a API deu na oferta: nada do que o agente declara é confiado. A API só reinscreve a sessão se o bilhete é dela (assinatura válida), não venceu, é deste mesmo agente (o da conexão) e da mesma `sessionId`, e se a sessão de login que abriu o canal ainda existe e não foi revogada; então reconfere as permissões com as regras da oferta. Reconhecida: pc.rtc.reconciled.v1; sem direito, com escopo a menos ou sem bilhete válido: pc.rtc.close.v1 (`revoked` ou `rescoped`). Só vai de um canal cuja oferta trouxe `ticket`, e a API só aceita de uma conexão que declarou pc.rtc.reconcile.v1. Sem resposta em 10 segundos, o agente fecha o canal.
 */
export interface PcRtcReconcileV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.reconcile.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcReconcileV1Body;
}
export interface PcRtcReconcileV1Body {
  /**
   * @minItems 1
   * @maxItems 1
   */
  sessions: [PcRtcReconcileV1BodySessionsItem];
}
export interface PcRtcReconcileV1BodySessionsItem {
  sessionId: string;
  /**
   * Bilhete opaco assinado pela API na oferta (HMAC sobre a sessão, quem abriu, a sessão de login, o aparelho, os escopos, a TV e o agente, com a validade do canal). O agente só o guarda e o devolve em pc.rtc.reconcile.v1; nunca o interpreta.
   */
  ticket: string;
}
