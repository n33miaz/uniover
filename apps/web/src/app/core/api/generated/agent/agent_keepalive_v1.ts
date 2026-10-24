/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: batimento sem efeito de negócio para manter o canal WebSocket ativo no proxy.
 */
export interface AgentKeepaliveV1Message {
  v: 1;
  id: string;
  type: 'agent.keepalive.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: null;
  body: AgentKeepaliveV1Body;
}
export interface AgentKeepaliveV1Body {}
