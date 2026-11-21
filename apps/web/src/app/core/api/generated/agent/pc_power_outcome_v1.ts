/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcPowerOutcomeV1BodyAction = 'SHUTDOWN' | 'RESTART';
export type PcPowerOutcomeV1BodyOutcome = 'refused' | 'lost';

/**
 * Agente para API: a contagem de desligar ou reiniciar (`pc.power.v1`/`pc.power.v2`) não terminou no que o app pediu. `refused`: ao fim da contagem o Windows recusou o pedido (política, permissão; `code` é o código de saída do `shutdown.exe`, quando houve); `lost`: o agente reiniciou no meio da contagem, que vivia só na memória dele, e o PC não vai desligar nem reiniciar. A API grava a falha na auditoria (`pc_shutdown_failed` ou `pc_restart_failed`, com quem pediu, se ela ainda lembra) e devolve o último resultado em `GET /api/v1/pc/status` (`power`), para o app parar de oferecer o cancelamento. Só vai a uma API que listou `pc.power.outcome.v1` em `features` (uma anterior recusaria o tipo). Sem resposta.
 */
export interface PcPowerOutcomeV1Message {
  v: 1;
  id: string;
  type: 'pc.power.outcome.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcPowerOutcomeV1Body;
}
export interface PcPowerOutcomeV1Body {
  action: PcPowerOutcomeV1BodyAction;
  outcome: PcPowerOutcomeV1BodyOutcome;
  code?: number;
  at: string;
}
