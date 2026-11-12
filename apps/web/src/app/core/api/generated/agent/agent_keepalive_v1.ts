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
export interface AgentKeepaliveV1Body {
  /**
   * Maior atraso do laço principal do agente desde o batimento anterior, em milissegundos. Opcional: os agentes anteriores não o mandam, e o agente só o manda à API que lista agent.keepalive.loop_lag em features.
   */
  loopLagMs?: number;
}
