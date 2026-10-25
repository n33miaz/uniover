/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type AgentUpdateStatusV1BodyOutcome =
  'not_checked' | 'updating' | 'updated' | 'up_to_date' | 'failed' | 'blocked' | 'rolled_back';

/**
 * Agente para API quando a checagem de atualização roda (ou termina, falha ou volta à versão anterior): o estado da auto-atualização, o mesmo objeto que o agent.hello.v1 leva em `update`. Só informativo, para a tela do administrador.
 */
export interface AgentUpdateStatusV1Message {
  v: 1;
  id: string;
  type: 'agent.update.status.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: null;
  body: AgentUpdateStatusV1Body;
}
export interface AgentUpdateStatusV1Body {
  outcome: AgentUpdateStatusV1BodyOutcome;
  installedSha?: string;
  installedAt?: string;
  latestSha?: string;
  checkedAt?: string;
  nextCheckAt?: string;
  reason?: string;
  blockedSha?: string;
  previousSha?: string;
  rolledBack?: boolean;
}
