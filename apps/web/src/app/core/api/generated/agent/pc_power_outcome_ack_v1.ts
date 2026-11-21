/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcPowerOutcomeAckV1BodyOutcome = 'refused' | 'lost' | 'cancelled';

/**
 * API para agente: o desfecho de contagem (`pc.power.outcome.v1`) com este `countdownId` e este `outcome` está resolvido na API: gravado na auditoria agora, já gravado antes (o agente reenviou), ou sem como gravar. Só depois disso o agente esquece o desfecho (e, num `lost`, a marca em disco da contagem perdida); sem a confirmação ele o reenvia a cada conexão e, com a conexão de pé, de tempos em tempos, e a API descarta a repetição e confirma de novo. Se a gravação falha, a API não confirma. Só vai ao agente que declarou a capacidade `pc.power.outcome.ack.v1` (depois de a API listá-la em `features`). Sem resposta.
 */
export interface PcPowerOutcomeAckV1Message {
  v: 1;
  id: string;
  type: 'pc.power.outcome.ack.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcPowerOutcomeAckV1Body;
}
export interface PcPowerOutcomeAckV1Body {
  countdownId: string;
  outcome: PcPowerOutcomeAckV1BodyOutcome;
}
