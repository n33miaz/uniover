/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcPowerOutcomeV1BodyAction = 'SHUTDOWN' | 'RESTART';
export type PcPowerOutcomeV1BodyOutcome = 'refused' | 'lost' | 'cancelled';

/**
 * Agente para API: a contagem de desligar ou reiniciar (`pc.power.v1`/`pc.power.v2`) não terminou no que o app pediu. `countdownId` é o identificador opaco da contagem: o `id` do comando `pc.power` que a agendou (nada de quem pediu vai ao agente). `refused`: ao fim da contagem o Windows recusou o pedido (política, permissão; `code` é o código de saída do `shutdown.exe`, quando houve); `lost`: o agente reiniciou no meio da contagem, que vivia só na memória dele, e o PC não vai desligar nem reiniciar; `cancelled`: quem está no PC cancelou no aviso da tela. `at` é quando aconteceu, no relógio do agente. A API grava na auditoria a falha (`pc_shutdown_failed`/`pc_restart_failed`) ou o cancelamento (`pc_shutdown_cancelled`), uma vez por contagem, com quem pediu se ela ainda lembra daquela contagem, e devolve o desfecho em `GET /api/v1/pc/status` (`power`) só enquanto ele for da contagem mais recente, para o app parar de oferecer o cancelamento. Só vai a uma API que listou `pc.power.outcome.v1` em `features` (uma anterior recusaria o tipo). Sem resposta.
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
  countdownId: string;
  action: PcPowerOutcomeV1BodyAction;
  outcome: PcPowerOutcomeV1BodyOutcome;
  code?: number;
  at: string;
}
