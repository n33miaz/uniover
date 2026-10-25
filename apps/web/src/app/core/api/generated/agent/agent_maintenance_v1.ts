/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type AgentMaintenanceV1BodyAction = 'update' | 'restart' | 'rollback';

/**
 * API para agente: manutenção remota pedida pelo administrador (com passkey). update: pede ao supervisor que rode a auto-atualização agora, e o agente reinicia só se houver versão nova; restart: pede ao supervisor que reinicie o agente; rollback: pede ao supervisor que volte para a versão anterior (a pasta app.previous guardada pela última atualização), bloqueando a versão que sai, e reinicie. O agente responde com command.result.v1 assim que o pedido foi entregue ao supervisor. Só agentes que anunciam a capacidade agent.maintenance.v1 recebem este pedido.
 */
export interface AgentMaintenanceV1Message {
  v: 1;
  id: string;
  type: 'agent.maintenance.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: AgentMaintenanceV1Body;
}
export interface AgentMaintenanceV1Body {
  action: AgentMaintenanceV1BodyAction;
}
