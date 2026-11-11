/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: respostas a pc.rtc.reconcile.v1. As sessões em `sessionIds` foram reconhecidas e conferidas (com o direito de pé para todos os escopos) e seguem abertas. As demais saem de pc.rtc.close.v1. Só vai a quem declara pc.rtc.reconcile.v1. Sem resposta do agente.
 */
export interface PcRtcReconciledV1Message {
  v: 1;
  id: string;
  type: 'pc.rtc.reconciled.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcRtcReconciledV1Body;
}
export interface PcRtcReconciledV1Body {
  /**
   * @minItems 1
   * @maxItems 1
   */
  sessionIds: [string];
}
